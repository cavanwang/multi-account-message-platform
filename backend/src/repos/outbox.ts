/**
 * 出站消息仓储层：outbox_messages 的 SQL 只出现在这里。
 *
 * 崩溃安全设计（规划 03 §2.1，INV-1 / INV-2）：
 *  - enqueue 在调用方业务事务内 INSERT（先落库，再发网关）；
 *  - claimQueued 在**短事务**内完成"选行 + 行锁 + generation+1"并立即提交：
 *    generation 记录"已向网关发出 HTTP 的次数"，必须先于 HTTP 持久化——
 *    若崩溃在 HTTP 飞行期，重启后看到 generation>0 的 queued 行，
 *    就知道必须先走 by-client-id 查询确认，而不是盲目重发；
 *  - 状态推进用 version CAS（transitionCAS），防止与终态取消（markTerminal）、
 *    事件回填（message_sent）等并发写互相覆盖。
 *
 * 队列语义：
 *  - FOR UPDATE SKIP LOCKED 解决"多 worker 抢同一批行"的分配问题；
 *    锁随 claim 短事务提交即释放，HTTP 调用不持有锁；
 *  - claim 只取 online 账号的行（规划 §2.4：rate_limited 等待期内不发，
 *    idle/disconnected 等重新上线后按 created_at 原序发出）。
 */
import type { Pool, PoolClient } from 'pg';
import type { Queryable } from './web-events.js';

export type DeliveryStatus = 'queued' | 'accepted' | 'sent' | 'failed' | 'unknown' | 'cancelled';
export type OutboxOrigin = 'api' | 'agent' | 'sequence';

export interface OutboxRow {
  readonly id: string;
  readonly groupId: string;
  /** accounts.id（UUID），非 text accountId。 */
  readonly accountId: string;
  readonly clientMsgId: string;
  readonly text: string;
  readonly deliveryStatus: DeliveryStatus;
  readonly failCode: string | null;
  readonly origin: OutboxOrigin;
  /** 504 已重发次数（上限 1，由收敛 worker 维护）。 */
  readonly resendCount: number;
  /** 已向网关发出 HTTP 的次数（claim 即 +1，先于发出持久化）。 */
  readonly generation: number;
  readonly acceptedAt: Date | null;
  readonly gatewayMsgId: string | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

/**
 * claimQueued 的返回行：在 OutboxRow 基础上附带网关调用所需的文本 ID
 * （accounts.account_id 与 groups.gateway_group_id），避免 worker 逐行回查。
 */
export interface ClaimedRow extends OutboxRow {
  /** accounts.account_id（文本 ID，网关路径参数）。 */
  readonly accountTextId: string;
  /** groups.gateway_group_id（网关群 ID）。 */
  readonly gatewayGroupId: string;
}

interface DbClaimedExtra {
  account_text_id: string;
  gateway_group_id: string;
}

interface DbOutboxRow {
  id: string;
  group_id: string;
  account_id: string;
  client_msg_id: string;
  text: string;
  delivery_status: DeliveryStatus;
  fail_code: string | null;
  origin: OutboxOrigin;
  resend_count: number;
  generation: number;
  accepted_at: Date | null;
  gateway_msg_id: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

function fromDb(row: DbOutboxRow): OutboxRow {
  return {
    id: row.id,
    groupId: row.group_id,
    accountId: row.account_id,
    clientMsgId: row.client_msg_id,
    text: row.text,
    deliveryStatus: row.delivery_status,
    failCode: row.fail_code,
    origin: row.origin,
    resendCount: row.resend_count,
    generation: row.generation,
    acceptedAt: row.accepted_at,
    gatewayMsgId: row.gateway_msg_id,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export interface EnqueueInput {
  /** groups.id（UUID）。 */
  readonly groupId: string;
  /** accounts.id（UUID）。 */
  readonly accountId: string;
  /** 调用方生成的幂等键（UUID），发前就持久化（INV-1）。 */
  readonly clientMsgId: string;
  readonly text: string;
  readonly origin: OutboxOrigin;
}

/** transitionCAS 的附带列更新：各列"只填不清"，不传则保持原值（COALESCE）。 */
export interface TransitionUpdates {
  /** failed/cancelled 时必填（DB CHECK 约束兜底，service 层负责语义）。 */
  readonly failCode?: string;
  readonly acceptedAt?: Date;
  readonly gatewayMsgId?: string;
  readonly sentAt?: Date;
}

export class OutboxRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * 入队（INV-1 先落库）。可在调用方事务内调用（传 PoolClient），
   * 也可独立自动提交（传 Pool）。
   */
  async enqueue(queryable: Queryable, input: EnqueueInput): Promise<OutboxRow> {
    const { rows } = await queryable.query<DbOutboxRow>(
      `INSERT INTO outbox_messages (group_id, account_id, client_msg_id, text, delivery_status, origin)
       VALUES ($1, $2, $3, $4, 'queued', $5)
       RETURNING *`,
      [input.groupId, input.accountId, input.clientMsgId, input.text, input.origin],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('outbox 入队失败：INSERT 未返回行');
    return fromDb(row);
  }

  /**
   * 取待发消息（outbox worker 用）。
   *
   * 必须在事务内调用（参数强制 PoolClient，类型层面防止误用 Pool 导致
   * 行锁随自动提交立即释放）：子查询 FOR UPDATE SKIP LOCKED 选行上锁，
   * 外层 UPDATE generation+1。调用方拿到结果后应立即 COMMIT 释放锁，
   * 再发 HTTP；崩溃时行仍 queued 且 generation>0 → 重启后先 by-client-id 确认。
   *
   * `FOR UPDATE OF o` 只锁 outbox 行，不锁 JOIN 到的 accounts 行
   * （否则 claim 会阻塞账号状态转移）。
   *
   * 排序按 (created_at, client_msg_id)：created_at 为事务时间，同事务批量
   * 入队时可能相同，client_msg_id 作稳定破平键保证确定性。
   */
  async claimQueued(client: PoolClient, limit: number): Promise<ClaimedRow[]> {
    const { rows } = await client.query<DbOutboxRow & DbClaimedExtra>(
      `UPDATE outbox_messages
       SET generation = generation + 1, updated_at = now()
       WHERE id IN (
         SELECT o.id FROM outbox_messages o
         JOIN accounts a ON a.id = o.account_id
         WHERE o.delivery_status = 'queued'
           AND a.status = 'online'
         ORDER BY o.created_at, o.client_msg_id
         LIMIT $1
         FOR UPDATE OF o SKIP LOCKED
       )
       RETURNING *,
         (SELECT a.account_id FROM accounts a WHERE a.id = outbox_messages.account_id) AS account_text_id,
         (SELECT g.gateway_group_id FROM groups g WHERE g.id = outbox_messages.group_id) AS gateway_group_id`,
      [limit],
    );
    // UPDATE ... RETURNING 不保证顺序，按 (created_at, client_msg_id) 重排保持 FIFO 语义
    return rows
      .map((r) => ({
        ...fromDb(r),
        accountTextId: r.account_text_id,
        gatewayGroupId: r.gateway_group_id,
      }))
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.clientMsgId.localeCompare(b.clientMsgId),
      );
  }

  /**
   * CAS 状态推进：WHERE id + version，冲突或行不存在时返回 null。
   * 转移合法性（如 unknown 只能往 accepted/failed 走）由 service 层（delivery）判定，
   * repo 只做原子更新；failed/cancelled 必须带 failCode 由 DB CHECK 约束兜底。
   */
  async transitionCAS(
    queryable: Queryable,
    id: string,
    expectedVersion: number,
    toStatus: DeliveryStatus,
    updates: TransitionUpdates = {},
  ): Promise<OutboxRow | null> {
    const { rows, rowCount } = await queryable.query<DbOutboxRow>(
      `UPDATE outbox_messages
       SET delivery_status = $1,
           fail_code     = COALESCE($2, fail_code),
           accepted_at   = COALESCE($3, accepted_at),
           gateway_msg_id = COALESCE($4, gateway_msg_id),
           sent_at       = COALESCE($5, sent_at),
           version = version + 1,
           updated_at = now()
       WHERE id = $6 AND version = $7
       RETURNING *`,
      [
        toStatus,
        updates.failCode ?? null,
        updates.acceptedAt ?? null,
        updates.gatewayMsgId ?? null,
        updates.sentAt ?? null,
        id,
        expectedVersion,
      ],
    );
    const updated = rows[0];
    if (rowCount === 0 || updated === undefined) return null;
    return fromDb(updated);
  }

  async findById(id: string): Promise<OutboxRow | undefined> {
    const { rows } = await this.pool.query<DbOutboxRow>(
      'SELECT * FROM outbox_messages WHERE id = $1',
      [id],
    );
    return rows[0] !== undefined ? fromDb(rows[0]) : undefined;
  }

  /** 按幂等键查询：by-client-id 收敛与 API 幂等复用。 */
  async findByClientMsgId(clientMsgId: string): Promise<OutboxRow | undefined> {
    const { rows } = await this.pool.query<DbOutboxRow>(
      'SELECT * FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    return rows[0] !== undefined ? fromDb(rows[0]) : undefined;
  }
}
