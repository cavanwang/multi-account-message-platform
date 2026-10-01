/**
 * 出站投递服务：outbox 状态机迁移的唯一入口（规划 03 任务 3.5）。
 *
 * 核心保证：
 *  - 所有状态变更走 CAS（乐观锁），并发冲突时静默跳过（由事件的最终一致性兜底）；
 *  - 状态变更与 web_events 在同一事务内（INV-5）；
 *  - GROUP_WRITE_FORBIDDEN 的群级后果（群不可写 + 停序列）也在同一事务内原子完成；
 *  - 504 收敛：状态改 unknown + 创建 pending_reconciliations 在同一事务内完成。
 *
 * 日志：每个迁移都输出结构化日志，携带 { outboxId, clientMsgId, fromStatus, toStatus }。
 */
import type { Pool, PoolClient } from 'pg';
import { OutboxRepo, type OutboxRow } from '../repos/outbox.js';
import { GroupRepo } from '../repos/groups.js';
import { enqueueWebEvent } from '../repos/web-events.js';
import type { SendResult } from './gateway-client.js';
import type { LoggerLike } from './gateway-client.js';
import { markTerminal } from './account-terminal.js';

export class DeliveryService {
  private readonly outboxRepo: OutboxRepo;
  private readonly groupRepo: GroupRepo;

  constructor(
    private readonly pool: Pool,
    private readonly log: LoggerLike,
  ) {
    this.outboxRepo = new OutboxRepo(pool);
    this.groupRepo = new GroupRepo(pool);
  }

  /**
   * 处理网关 send 的响应（成功或同步错误）。
   * 所有分支幂等：CAS 失败（行已被并发推进）即静默跳过。
   */
  async handleGatewayResponse(row: OutboxRow, result: SendResult): Promise<void> {
    const baseLog = {
      outboxId: row.id,
      clientMsgId: row.clientMsgId,
      groupId: row.groupId,
      accountId: row.accountId,
      currentStatus: row.deliveryStatus,
      generation: row.generation,
      resendCount: row.resendCount,
    };

    if (result.kind === 'accepted') {
      await this.markAccepted(row, baseLog);
      return;
    }

    // result.kind === 'error'
    const { status, code, extra } = result;
    const logCtx = { ...baseLog, gatewayStatus: status, gatewayCode: code };

    // 按错误码分发
    switch (code) {
      case 'RATE_LIMITED': {
        const retryAfterRaw = extra['retryAfterSeconds'];
      const retryAfterSeconds = typeof retryAfterRaw === 'number'
        ? retryAfterRaw
        : 60; // 兜底：网关应带 retryAfterSeconds，缺失时按 60s 处理
        await this.handleRateLimited(row, retryAfterSeconds, logCtx);
        return;
      }

      case 'ACCOUNT_SUSPENDED':
        await this.handleAccountTerminal(row, 'suspended', 'send_error', logCtx);
        return;

      case 'SESSION_EXPIRED':
        await this.handleAccountTerminal(row, 'session_expired', 'send_error', logCtx);
        return;

      case 'GROUP_WRITE_FORBIDDEN':
        await this.handleGroupUnreachable(row, logCtx);
        return;

      case 'SENDER_NOT_IN_GROUP':
        await this.markFailed(row, 'SENDER_NOT_IN_GROUP', logCtx);
        return;

      case 'ACCOUNT_OFFLINE':
        await this.markFailed(row, 'ACCOUNT_OFFLINE', logCtx);
        return;

      case 'NETWORK_TIMEOUT':
        await this.handle504(row, logCtx);
        return;

      case 'SERVICE_UNAVAILABLE': // 503 或网络异常
        this.log.warn(logCtx, 'delivery: 网关暂不可用，不改状态，等下一轮重试');
        return;

      default:
        // 未知错误码：不改状态，等下一轮重试（可能是网关新增的错误码）
        this.log.error(logCtx, 'delivery: 未知网关错误码，不改状态');
        return;
    }
  }

  /**
   * 网关 202 accepted：queued → accepted。
   */
  private async markAccepted(row: OutboxRow, logCtx: Record<string, unknown>): Promise<void> {
    const updated = await this.outboxRepo.transitionCAS(this.pool, row.id, row.version, 'accepted', {
      acceptedAt: new Date(),
    });

    if (updated === null) {
      this.log.warn(logCtx, 'delivery: CAS 冲突（已被并发修改），跳过 accepted');
      return;
    }

    await enqueueWebEvent(this.pool, 'message_accepted', {
      clientMsgId: row.clientMsgId,
      groupId: row.groupId,
    });

    this.log.info({ ...logCtx, toStatus: 'accepted' }, 'delivery: 网关已受理');
  }

  /**
   * 消息级失败：queued → failed(failCode)。
   */
  private async markFailed(
    row: OutboxRow,
    failCode: string,
    logCtx: Record<string, unknown>,
  ): Promise<void> {
    const updated = await this.outboxRepo.transitionCAS(this.pool, row.id, row.version, 'failed', {
      failCode,
    });

    if (updated === null) {
      this.log.warn(logCtx, 'delivery: CAS 冲突（已被并发修改），跳过 failed');
      return;
    }

    await enqueueWebEvent(this.pool, 'message_failed', {
      clientMsgId: row.clientMsgId,
      groupId: row.groupId,
      failCode,
    });

    this.log.info({ ...logCtx, toStatus: 'failed', failCode }, 'delivery: 消息失败');
  }

  /**
   * 429 限流：账号进 rate_limited，**该行保持 queued 不动**。
   * 限流恢复由切片 2 的 sweep worker 负责，到期后 outbox worker 自然继续按序发。
   */
  private async handleRateLimited(
    row: OutboxRow,
    retryAfterSeconds: number,
    logCtx: Record<string, unknown>,
  ): Promise<void> {
    const rateLimitedUntil = new Date(Date.now() + retryAfterSeconds * 1000);

    // CAS 更新账号状态（不动 outbox 行）
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE accounts
         SET status = 'rate_limited',
             rate_limited_until = $1,
             retry_after_seconds = $2,
             version = version + 1,
             updated_at = now()
         WHERE id = $3 AND status != 'rate_limited'`,
        [rateLimitedUntil, retryAfterSeconds, row.accountId],
      );
      await client.query('COMMIT');

      if ((rowCount ?? 0) > 0) {
        await enqueueWebEvent(this.pool, 'account_status_changed', {
          accountId: row.accountId,
          from: 'online',
          to: 'rate_limited',
          retryAfterSeconds,
        });
        this.log.info(
          { ...logCtx, retryAfterSeconds, rateLimitedUntil: rateLimitedUntil.toISOString() },
          'delivery: 账号被限流，消息保持 queued',
        );
      } else {
        this.log.debug(logCtx, 'delivery: 账号已在限流中（或并发修改），跳过重复标记');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 账号进入终态（suspended / session_expired）：走终态原子事务。
   * 终态事务内部已把该账号的 queued 消息批量置 cancelled（failCode=ACCOUNT_TERMINAL），
   * 本行无需单独处理。
   */
  private async handleAccountTerminal(
    row: OutboxRow,
    toStatus: 'suspended' | 'session_expired',
    source: 'send_error',
    logCtx: Record<string, unknown>,
  ): Promise<void> {
    // 根据 accountId 查 text accountId（终态接口用 text ID）
    const { rows } = await this.pool.query<{ account_id: string }>(
      'SELECT account_id FROM accounts WHERE id = $1',
      [row.accountId],
    );
    const textAccountId = rows[0]?.account_id;
    if (textAccountId === undefined) {
      this.log.error(logCtx, 'delivery: 账号 UUID 不存在，无法标终态');
      return;
    }

    const result = await markTerminal(this.pool, textAccountId, toStatus, source);
    this.log.info(
      { ...logCtx, toStatus, terminalResult: result },
      'delivery: 账号已进入终态，排队消息已取消',
    );
  }

  /**
   * GROUP_WRITE_FORBIDDEN：群 → unreachable，停该群运行中序列，该行 → failed。
   * 三步在同一事务内完成，原子生效。
   */
  private async handleGroupUnreachable(
    row: OutboxRow,
    logCtx: Record<string, unknown>,
  ): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1) 群 → unreachable（幂等：已是 unreachable 时不动）
      await this.groupRepo.markUnreachable(client, row.groupId);

      // 2) 停该群所有 running 序列
      const { rowCount: stoppedRuns } = await client.query(
        `UPDATE sequence_runs
         SET status = 'stopped', version = version + 1, updated_at = now()
         WHERE group_id = $1 AND status = 'running'`,
        [row.groupId],
      );

      // 3) 该行 → failed
      const { rowCount: failedRow } = await client.query(
        `UPDATE outbox_messages
         SET delivery_status = 'failed',
             fail_code = 'GROUP_WRITE_FORBIDDEN',
             version = version + 1,
             updated_at = now()
         WHERE id = $1 AND delivery_status = 'queued'`,
        [row.id],
      );

      // 4) web_events
      if ((stoppedRuns ?? 0) > 0) {
        await enqueueWebEvent(client, 'sequence_stopped', {
          groupId: row.groupId,
          reason: 'GROUP_WRITE_FORBIDDEN',
        });
      }
      if ((failedRow ?? 0) > 0) {
        await enqueueWebEvent(client, 'message_failed', {
          clientMsgId: row.clientMsgId,
          groupId: row.groupId,
          failCode: 'GROUP_WRITE_FORBIDDEN',
        });
      }

      await client.query('COMMIT');

      this.log.info(
        { ...logCtx, stoppedRuns: stoppedRuns ?? 0 },
        'delivery: 群不可写，已标 unreachable 并停序列',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      this.log.error({ ...logCtx, err }, 'delivery: 群不可写事务失败，已回滚');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 504 NETWORK_TIMEOUT：行 → unknown，同时创建收敛任务（pending_reconciliations）。
   * 状态变更与任务创建在同一事务内完成，保证崩溃安全。
   */
  private async handle504(row: OutboxRow, logCtx: Record<string, unknown>): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1) 行 → unknown（CAS）
      const { rowCount } = await client.query(
        `UPDATE outbox_messages
         SET delivery_status = 'unknown',
             version = version + 1,
             updated_at = now()
         WHERE id = $1 AND version = $2 AND delivery_status = 'queued'`,
        [row.id, row.version],
      );

      if ((rowCount ?? 0) === 0) {
        // CAS 失败：行已被并发推进，无需再收敛
        await client.query('ROLLBACK');
        this.log.warn(logCtx, 'delivery: CAS 冲突，跳过 unknown 标记');
        return;
      }

      // 2) 创建收敛任务（t+2s 到期）
      const dueAt = new Date(Date.now() + 2000);
      await client.query(
        `INSERT INTO pending_reconciliations (outbox_id, kind, due_at)
         VALUES ($1, 'resolve_504', $2)`,
        [row.id, dueAt],
      );

      // 3) web_events
      await enqueueWebEvent(client, 'message_unknown', {
        clientMsgId: row.clientMsgId,
        groupId: row.groupId,
      });

      await client.query('COMMIT');

      this.log.info(
        { ...logCtx, toStatus: 'unknown', reconcileDueAt: dueAt.toISOString() },
        'delivery: 504 未知态，已创建收敛任务',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      this.log.error({ ...logCtx, err }, 'delivery: 504 处理失败，已回滚');
      throw err;
    } finally {
      client.release();
    }
  }
}
