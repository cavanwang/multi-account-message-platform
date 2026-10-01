/**
 * 出站发送 worker（规划 03 任务 3.4）。
 *
 * 核心逻辑：
 *   1. 短事务 claimQueued（FOR UPDATE SKIP LOCKED + generation+1）；
 *   2. 按 (created_at, client_msg_id) 顺序逐条发网关；
 *   3. 按错误码调用 DeliveryService 处理（202/429/403/401/409/503/504）；
 *   4. 网关整体不可用（503/网络异常）→ 指数退避，**不改任何状态**；
 *   5. 批内记忆：账号 429/终态后跳过该账号剩余行；群不可写后跳过该群剩余行。
 *
 * 崩溃安全：
 *   - claim 时 generation 已落库；若崩溃在"HTTP 已发但未收到响应"，
 *     重启后看到 generation>0 的 queued 行，由收敛 worker（任务 3.6）兜底；
 *   - 所有状态推进走 CAS（乐观锁），并发冲突静默跳过。
 *
 * 日志：每条消息全生命周期带 { clientMsgId, outboxId, groupId, accountId,
 * gatewayStatus, gatewayCode }，批次摘要带 { claimed, sent, skipped, failed }。
 */
import type { Pool } from 'pg';
import { OutboxRepo, type ClaimedRow } from '../repos/outbox.js';
import type { SendGateway, SendResult } from '../services/gateway-client.js';
import type { LoggerLike } from '../services/gateway-client.js';
import { DeliveryService } from '../services/delivery.js';

export interface OutboxSenderOptions {
  /** 每批最多取多少条，默认 10。 */
  batchSize?: number;
  /** 正常轮询间隔（毫秒），默认 1000。 */
  intervalMs?: number;
  /** 网关不可用时的基础退避（毫秒），默认 2000。 */
  backoffBaseMs?: number;
  /** 最大退避（毫秒），默认 30_000。 */
  maxBackoffMs?: number;
}

/** 批处理结果统计（用于日志）。 */
interface BatchStats {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  gatewayUnavailable: boolean;
}

export class OutboxSender {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveGatewayFailures = 0;
  private readonly outboxRepo: OutboxRepo;
  private readonly delivery: DeliveryService;
  private readonly opts: Required<OutboxSenderOptions>;

  constructor(
    private readonly pool: Pool,
    private readonly gateway: SendGateway,
    private readonly log: LoggerLike,
    options: OutboxSenderOptions = {},
  ) {
    this.outboxRepo = new OutboxRepo(pool);
    this.delivery = new DeliveryService(pool, log);
    this.opts = {
      batchSize: options.batchSize ?? 10,
      intervalMs: options.intervalMs ?? 1000,
      backoffBaseMs: options.backoffBaseMs ?? 2000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
    };
  }

  /** 启动 worker。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info('outbox-sender: 启动');
    this.scheduleNext(0);
  }

  /** 停止 worker（优雅关闭）。 */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log.info('outbox-sender: 停止');
  }

  /**
   * 测试/手动触发：立即执行一轮。
   * 正常 worker 循环由 start() 驱动，此方法供测试确定性调用。
   */
  async runOnce(): Promise<void> {
    await this.processBatch();
  }

  private scheduleNext(delayMs?: number): void {
    if (!this.running) return;
    const delay = delayMs ?? this.nextDelay();
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private nextDelay(): number {
    if (this.consecutiveGatewayFailures === 0) return this.opts.intervalMs;
    const backoff = this.opts.backoffBaseMs * 2 ** (this.consecutiveGatewayFailures - 1);
    return Math.min(backoff, this.opts.maxBackoffMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.processBatch();
    } catch (err) {
      this.log.error({ err }, 'outbox-sender: 批处理未预期异常');
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * 一轮批处理：claim → 逐条发 → 处理响应。
   */
  private async processBatch(): Promise<void> {
    const client = await this.pool.connect();
    let claimed: ClaimedRow[];
    try {
      await client.query('BEGIN');
      claimed = await this.outboxRepo.claimQueued(client, this.opts.batchSize);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (claimed.length === 0) {
      this.consecutiveGatewayFailures = 0;
      return;
    }

    const stats: BatchStats = {
      claimed: claimed.length,
      sent: 0,
      skipped: 0,
      failed: 0,
      gatewayUnavailable: false,
    };

    // 批内记忆：账号被限流/进终态 → 跳过剩余；群不可写 → 跳过剩余
    const rateLimitedAccounts = new Set<string>();
    const terminalAccounts = new Set<string>();
    const unreachableGroups = new Set<string>();

    for (const row of claimed) {
      const logCtx = {
        clientMsgId: row.clientMsgId,
        outboxId: row.id,
        groupId: row.groupId,
        accountId: row.accountId,
        accountTextId: row.accountTextId,
        generation: row.generation,
        resendCount: row.resendCount,
      };

      // 批内跳过：账号已被限流/终态
      if (rateLimitedAccounts.has(row.accountId) || terminalAccounts.has(row.accountId)) {
        this.log.debug(logCtx, 'outbox-sender: 批内跳过（账号不可用）');
        stats.skipped++;
        continue;
      }

      // 批内跳过：群不可写
      if (unreachableGroups.has(row.groupId)) {
        this.log.debug(logCtx, 'outbox-sender: 批内跳过（群不可写）');
        stats.skipped++;
        // 直接标失败（无需再调网关）
        try {
          await this.delivery.handleGatewayResponse(row, {
            kind: 'error',
            status: 403,
            code: 'GROUP_WRITE_FORBIDDEN',
            extra: {},
          });
        } catch (err) {
          this.log.error({ ...logCtx, err }, 'outbox-sender: 批内标失败出错');
        }
        stats.failed++;
        continue;
      }

      // 调网关
      let result: SendResult;
      try {
        result = await this.gateway.send(
          row.gatewayGroupId,
          row.accountTextId,
          row.clientMsgId,
          row.text,
        );
      } catch (err) {
        // SendGateway 实现内部应已收敛网络异常为 503；这里兜底
        this.log.error({ ...logCtx, err }, 'outbox-sender: 网关调用抛异常');
        result = { kind: 'error', status: 503, code: 'SERVICE_UNAVAILABLE', extra: {} };
      }

      // 网关整体不可用：退避，本批不再发
      if (
        result.kind === 'error' &&
        (result.status === 503 || result.code === 'SERVICE_UNAVAILABLE')
      ) {
        this.consecutiveGatewayFailures++;
        stats.gatewayUnavailable = true;
        this.log.warn(
          { ...logCtx, consecutiveFailures: this.consecutiveGatewayFailures },
          'outbox-sender: 网关不可用，进入退避',
        );
        break; // 本批剩余行保持 queued，等下轮
      }

      // 处理业务响应
      try {
        await this.delivery.handleGatewayResponse(row, result);
      } catch (err) {
        // 单个消息处理失败不中断批处理（幂等性保证下轮可重试）
        this.log.error({ ...logCtx, err }, 'outbox-sender: 处理响应失败');
        stats.failed++;
        continue;
      }

      // 根据结果更新批内记忆与统计
      if (result.kind === 'accepted') {
        stats.sent++;
      } else {
        switch (result.code) {
          case 'RATE_LIMITED':
            rateLimitedAccounts.add(row.accountId);
            stats.failed++;
            break;
          case 'ACCOUNT_SUSPENDED':
          case 'SESSION_EXPIRED':
            terminalAccounts.add(row.accountId);
            stats.failed++;
            break;
          case 'GROUP_WRITE_FORBIDDEN':
            unreachableGroups.add(row.groupId);
            stats.failed++;
            break;
          case 'SENDER_NOT_IN_GROUP':
          case 'ACCOUNT_OFFLINE':
          case 'NETWORK_TIMEOUT':
            stats.failed++;
            break;
          default:
            stats.failed++;
            break;
        }
      }
    }

    // 网关恢复：重置退避计数
    if (!stats.gatewayUnavailable) {
      this.consecutiveGatewayFailures = 0;
    }

    this.log.info(stats, 'outbox-sender: 批处理完成');
  }
}
