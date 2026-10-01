/**
 * 504 收敛任务仓储（规划 03 任务 3.6）：pending_reconciliations 的读取/完成/重排。
 *
 * 简化假设：backend 单实例运行（docker-compose 单容器），无需分布式锁。
 * 多实例并发时，"行已定态 → 任务幂等清理"兜底，不产生副作用。
 */
import type { Pool } from 'pg';
import type { DeliveryStatus } from './outbox.js';

/** 到期收敛任务 + join 出的上下文。 */
export interface ReconTask {
  readonly taskId: string;
  readonly attempts: number;
  readonly outboxId: string;
  readonly outboxVersion: number;
  readonly clientMsgId: string;
  readonly text: string;
  readonly deliveryStatus: DeliveryStatus;
  readonly resendCount: number;
  readonly groupId: string;
  readonly accountTextId: string;
  readonly gatewayGroupId: string;
}

interface DbReconRow {
  task_id: string;
  attempts: number;
  outbox_id: string;
  outbox_version: number;
  client_msg_id: string;
  text: string;
  delivery_status: DeliveryStatus;
  resend_count: number;
  group_id: string;
  account_text_id: string;
  gateway_group_id: string;
}

export class ReconciliationRepo {
  constructor(private readonly pool: Pool) {}

  /** 读取到期任务（含上下文）。 */
  async listDue(limit: number): Promise<ReconTask[]> {
    const { rows } = await this.pool.query<DbReconRow>(
      `SELECT pr.id AS task_id, pr.attempts,
              o.id AS outbox_id, o.version AS outbox_version, o.client_msg_id, o.text,
              o.delivery_status, o.resend_count, o.group_id,
              a.account_id AS account_text_id, g.gateway_group_id
       FROM pending_reconciliations pr
       JOIN outbox_messages o ON o.id = pr.outbox_id
       JOIN accounts a ON a.id = o.account_id
       JOIN groups g ON g.id = o.group_id
       WHERE pr.due_at <= now()
       ORDER BY pr.due_at
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      taskId: r.task_id,
      attempts: r.attempts,
      outboxId: r.outbox_id,
      outboxVersion: r.outbox_version,
      clientMsgId: r.client_msg_id,
      text: r.text,
      deliveryStatus: r.delivery_status,
      resendCount: r.resend_count,
      groupId: r.group_id,
      accountTextId: r.account_text_id,
      gatewayGroupId: r.gateway_group_id,
    }));
  }

  /** 收敛完成：删除任务（幂等）。 */
  async complete(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM pending_reconciliations WHERE id = $1', [taskId]);
  }

  /** 查询不可用：退避重排。 */
  async retryLater(taskId: string, delayMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE pending_reconciliations
       SET due_at = now() + ($2 || ' milliseconds')::interval,
           attempts = attempts + 1
       WHERE id = $1`,
      [taskId, String(delayMs)],
    );
  }
}
