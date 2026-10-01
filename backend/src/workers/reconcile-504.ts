/**
 * 504 收敛 worker（规划 03 任务 3.6）。
 *
 * 轮询 pending_reconciliations，对到期的 resolve_504 任务：
 *   1. by-client-id 查询（GET /groups/:gid/messages/by-client-id/:cmid）
 *   2. 200 → unknown→accepted（回填 gateway_msg_id），清理任务
 *   3. 404 + resend_count=0 → prepareResend（先落库）→ 同一 clientMsgId 重发
 *      ├─ 202 → accepted，清理任务
 *      └─ 其他 → failed(NETWORK_TIMEOUT)，清理任务
 *   4. 404 + resend_count>=1 → failed(NETWORK_TIMEOUT)，清理任务
 *   5. 503/5xx → 退避重排（attempts+1，500ms×attempts，封顶 5s）
 *   6. 行已定态（非 unknown）→ 幂等清理任务
 *
 * 崩溃安全：
 *   - prepareResend 先 CAS 落库 resend_count+1 / generation+1，成功后才发 HTTP；
 *     崩溃后重启，行 generation>0 且 resend_count>0，不再走重发路径，直接判 failed。
 *   - 所有状态推进走 CAS（乐观锁），并发冲突时静默跳过。
 *
 * 日志：每个任务带 { clientMsgId, outboxId, taskId, attempts }，收敛决策与 HTTP 往返均有结构化日志。
 */
import type { Pool } from 'pg';
import { OutboxRepo } from '../repos/outbox.js';
import { ReconciliationRepo, type ReconTask } from '../repos/reconciliations.js';
import type { SendGateway, QueryGateway } from '../services/gateway-client.js';
import type { LoggerLike } from '../services/gateway-client.js';
import { DeliveryService } from '../services/delivery.js';

export interface ReconcileOptions {
  batchSize?: number;
  intervalMs?: number;
  /** by-client-id 查询不可用时的退避基数（毫秒），默认 500。 */
  backoffBaseMs?: number;
  /** 最大退避（毫秒），默认 5000。 */
  maxBackoffMs?: number;
  /** attempts 上限，默认 20。 */
  maxAttempts?: number;
}

export class Reconcile504Worker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly outboxRepo: OutboxRepo;
  private readonly reconRepo: ReconciliationRepo;
  private readonly delivery: DeliveryService;
  private readonly opts: Required<ReconcileOptions>;

  constructor(
    pool: Pool,
    private readonly queryGateway: QueryGateway,
    private readonly sendGateway: SendGateway,
    private readonly log: LoggerLike,
    options: ReconcileOptions = {},
  ) {
    this.outboxRepo = new OutboxRepo(pool);
    this.reconRepo = new ReconciliationRepo(pool);
    this.delivery = new DeliveryService(pool, log);
    this.opts = {
      batchSize: options.batchSize ?? 10,
      intervalMs: options.intervalMs ?? 1000,
      backoffBaseMs: options.backoffBaseMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 5000,
      maxAttempts: options.maxAttempts ?? 20,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info('reconcile-504: 启动');
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log.info('reconcile-504: 停止');
  }

  async runOnce(): Promise<void> {
    await this.processBatch();
  }

  private scheduleNext(delayMs?: number): void {
    if (!this.running) return;
    const delay = delayMs ?? this.opts.intervalMs;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.processBatch();
    } catch (err) {
      this.log.error({ err }, 'reconcile-504: 批处理异常');
    } finally {
      this.scheduleNext();
    }
  }

  private async processBatch(): Promise<void> {
    const tasks = await this.reconRepo.listDue(this.opts.batchSize);
    if (tasks.length === 0) return;

    let processed = 0;
    let resolved = 0;
    let retried = 0;
    let backoff = 0;

    for (const task of tasks) {
      const logCtx = {
        taskId: task.taskId,
        clientMsgId: task.clientMsgId,
        outboxId: task.outboxId,
        attempts: task.attempts,
      };

      // 保护：attempts 超限 → 兜底判失败，不无限循环
      if (task.attempts >= this.opts.maxAttempts) {
        this.log.warn(logCtx, 'reconcile-504: attempts 超限，兜底判失败');
        const row = await this.outboxRepo.findById(task.outboxId);
        if (row !== undefined && row.deliveryStatus === 'unknown') {
          await this.delivery.markReconciledFailed(row, 'MAX_ATTEMPTS_EXCEEDED');
        }
        await this.reconRepo.complete(task.taskId);
        processed++;
        continue;
      }

      // 检查 outbox 当前状态
      const row = await this.outboxRepo.findById(task.outboxId);
      if (row === undefined || row.deliveryStatus !== 'unknown') {
        this.log.debug(logCtx, 'reconcile-504: 行已定态，清理任务');
        await this.reconRepo.complete(task.taskId);
        resolved++;
        continue;
      }
      // 此后 row 非空且为 unknown

      // 查网关
      let queryResult: Awaited<ReturnType<QueryGateway['byClientId']>>;
      try {
        queryResult = await this.queryGateway.byClientId(
          task.gatewayGroupId,
          task.clientMsgId,
        );
      } catch (err) {
        this.log.warn({ ...logCtx, err }, 'reconcile-504: by-client-id 查询抛异常');
        queryResult = { kind: 'unavailable' };
      }

      if (queryResult.kind === 'found') {
        const ok = await this.delivery.markReconciledAccepted(row, queryResult.msgId);
        if (ok) {
          await this.reconRepo.complete(task.taskId);
          resolved++;
        }
        processed++;
        continue;
      }

      if (queryResult.kind === 'notFound') {
        if (row.resendCount >= 1) {
          // 已重发过且仍 404 → 判失败（不再发第二次）
          const ok = await this.delivery.markReconciledFailed(
            row,
            'ALREADY_RESENT_ONCE',
          );
          if (ok) {
            await this.reconRepo.complete(task.taskId);
            resolved++;
          }
        } else {
          // 首次 404 → 准备重发
          const newVersion = await this.outboxRepo.prepareResend(row.id, row.version);
          if (newVersion === null) {
            this.log.warn(logCtx, 'reconcile-504: prepareResend CAS 失败，跳过');
            continue;
          }

          retried++;
          this.log.info(logCtx, 'reconcile-504: 准备重发');

          let sendResult: Awaited<ReturnType<SendGateway['send']>>;
          try {
            sendResult = await this.sendGateway.send(
              task.gatewayGroupId,
              task.accountTextId,
              task.clientMsgId,
              task.text,
            );
          } catch (err) {
            this.log.error({ ...logCtx, err }, 'reconcile-504: 重发异常');
            sendResult = { kind: 'error', status: 503, code: 'SERVICE_UNAVAILABLE', extra: {} };
          }

          if (sendResult.kind === 'accepted') {
            // 重发成功 → accepted（CAS + web_event 同一事务，INV-5）
            const ok = await this.delivery.markResendAccepted(row, newVersion);
            if (!ok) {
              this.log.warn(logCtx, 'reconcile-504: 重发后 CAS 冲突');
            }
            await this.reconRepo.complete(task.taskId);
            resolved++;
          } else {
            // 重发任何失败 → failed(NETWORK_TIMEOUT)；version 已是 prepareResend 后的新版本
            await this.delivery.markReconciledFailed(
              { ...row, version: newVersion },
              'RESEND_FAILED',
            );
            await this.reconRepo.complete(task.taskId);
            resolved++;
          }
        }
        processed++;
        continue;
      }

      // queryResult.kind === 'unavailable'
      const delay = Math.min(
        this.opts.backoffBaseMs * (task.attempts + 1),
        this.opts.maxBackoffMs,
      );
      await this.reconRepo.retryLater(task.taskId, delay);
      backoff++;
      this.log.debug({ ...logCtx, delayMs: delay }, 'reconcile-504: 查询不可用，退避');
    }

    this.log.info({ processed, resolved, retried, backoff }, 'reconcile-504: 批处理完成');
  }
}
