/**
 * 账号终态服务：处理进入终态（suspended / session_expired）的原子后果。
 *
 * 终态原子后果（需求 §5 A1）：
 *   1. CAS 进入终态（已在终态则静默忽略）
 *   2. 移出所有群
 *   3. 排队中的发送 → cancelled (failCode = ACCOUNT_TERMINAL)
 *   4. 对应的序列步骤 → skipped
 *   5. 入队 web_events ('account_terminal')
 *
 * 以上 5 步在同一事务内，保证原子性（INV-6）。
 * 四种来源（send_error, gateway_event, operator, agent）共用同一函数。
 */
import type { Pool, PoolClient } from 'pg';
import type { AccountStatus } from '../domain/account-fsm.js';
import { isTerminal } from '../domain/account-fsm.js';

/** 终态来源：用于日志追踪，不影响行为。 */
export type TerminalSource = 'send_error' | 'gateway_event' | 'operator' | 'agent';

export interface TerminalResult {
  /** 是否实际执行了终态后果（false 表示已是终态，静默忽略）。 */
  executed: boolean;
  /** 被移出的群数。 */
  removedFromGroups: number;
  /** 被取消的排队消息数。 */
  cancelledMessages: number;
  /** 被跳过的序列步骤数。 */
  skippedSteps: number;
}

/**
 * 执行终态原子后果。
 *
 * @param pool 数据库连接池
 * @param accountId 账号 ID（accounts.account_id，非 UUID）
 * @param toStatus 目标终态（suspended 或 session_expired）
 * @param source 来源（用于日志）
 */
export async function markTerminal(
  pool: Pool,
  accountId: string,
  toStatus: 'suspended' | 'session_expired',
  source: TerminalSource,
): Promise<TerminalResult> {
  if (!isTerminal(toStatus)) {
    throw new Error(`markTerminal 只能用于终态，收到: ${toStatus}`);
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // 使用 advisory lock 防止并发触发终态后果
    // hashtext 将 accountId 转为整数，保证同一账号的终态操作串行
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('account_terminal:' || $1))",
      [accountId],
    );

    // 1) CAS 进入终态
    // 如果已是同一终态，rowCount=0，静默忽略
    const { rowCount: casRowCount } = await client.query(
      `UPDATE accounts
       SET status = $1,
           rate_limited_until = NULL,
           retry_after_seconds = NULL,
           version = version + 1,
           updated_at = now()
       WHERE account_id = $2
         AND status NOT IN ('suspended', 'session_expired')`,
      [toStatus, accountId],
    );

    if (casRowCount === 0) {
      // 已是终态，检查是否是同一终态（静默忽略）还是不存在
      const { rows } = await client.query<{ status: AccountStatus }>(
        'SELECT status FROM accounts WHERE account_id = $1',
        [accountId],
      );
      if (rows[0] === undefined) {
        throw new Error(`账号 ${accountId} 不存在`);
      }
      if (rows[0].status === toStatus) {
        // 重复进入同一终态，静默忽略
        await client.query('COMMIT');
        return { executed: false, removedFromGroups: 0, cancelledMessages: 0, skippedSteps: 0 };
      }
      // 已是另一个终态（理论上不应该发生，因为终态无出边）
      throw new Error(`账号 ${accountId} 已是终态 ${rows[0].status}，无法转为 ${toStatus}`);
    }

    // 获取账号的 UUID（用于关联查询）
    const { rows: accountRows } = await client.query<{ id: string }>(
      'SELECT id FROM accounts WHERE account_id = $1',
      [accountId],
    );
    const accountUuid = accountRows[0]?.id;
    if (accountUuid === undefined) {
      throw new Error(`账号 ${accountId} 不存在`);
    }

    // 2) 移出所有群
    const { rowCount: removedGroups } = await client.query(
      'DELETE FROM group_members WHERE account_id = $1',
      [accountUuid],
    );

    // 3) 排队中的发送 → cancelled
    const { rowCount: cancelledMsgs } = await client.query(
      `UPDATE outbox_messages
       SET delivery_status = 'cancelled',
           fail_code = 'ACCOUNT_TERMINAL',
           updated_at = now()
       WHERE account_id = $1
         AND delivery_status IN ('queued', 'unknown')`,
      [accountUuid],
    );

    // 4) 对应的序列步骤 → skipped
    const { rowCount: skippedStepsCount } = await client.query(
      `UPDATE sequence_steps
       SET status = 'skipped', updated_at = now()
       WHERE outbox_id IN (
         SELECT id FROM outbox_messages
         WHERE account_id = $1 AND delivery_status = 'cancelled'
       )
       AND status IN ('pending', 'accepted')`,
      [accountUuid],
    );

    // 5) 入队 web_events
    await client.query(
      `INSERT INTO web_events (type, payload)
       VALUES ('account_terminal', $1)`,
      [JSON.stringify({ accountId, status: toStatus, source })],
    );

    await client.query('COMMIT');

    return {
      executed: true,
      removedFromGroups: removedGroups ?? 0,
      cancelledMessages: cancelledMsgs ?? 0,
      skippedSteps: skippedStepsCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
