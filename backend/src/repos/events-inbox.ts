/**
 * 事件收件箱仓储层（规划 03 §2.5，INV-4）：events_inbox / events_cursor 的 SQL 只出现在这里。
 *
 * 核心语义：
 *  - ingestFrame：SSE 帧先落库（ON CONFLICT 去重）+ 推进游标，**同一事务**——
 *    崩溃后游标与收件箱一致，重连 since 独占语义正好衔接，不丢不重；
 *  - listPending / markProcessed / markAttemptFailed：消费循环的取数与定态，
 *    失败的行保留 last_error 且不置 processed_at，下轮重试（不中断、不丢内容）。
 */
import type { Pool } from 'pg';
import type { Queryable } from './web-events.js';

export interface InboxRow {
  readonly eventId: number;
  readonly type: string;
  readonly payload: unknown;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

interface DbInboxRow {
  event_id: string; // pg 把 BIGINT 返回为 string，防 JS 精度丢失（这里转换回 number）
  type: string;
  payload: unknown;
  received_at: Date;
  processed_at: Date | null;
  attempts: number;
  last_error: string | null;
}

function fromDb(row: DbInboxRow): InboxRow {
  return {
    eventId: Number(row.event_id),
    type: row.type,
    payload: row.payload,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

export class EventsInboxRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * 落库一帧 SSE 事件并推进游标（必须在同一事务内调用）。
   *
   * @returns true=新插入；false=eventId 已存在（重复推送，S2 去重），游标仍推进
   */
  async ingestFrame(
    queryable: Queryable,
    frame: { eventId: number; type: string; payload: unknown },
  ): Promise<boolean> {
    const { rowCount } = await queryable.query(
      `INSERT INTO events_inbox (event_id, type, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [frame.eventId, frame.type, JSON.stringify(frame.payload)],
    );

    // 游标单调推进（GREATEST 防止乱序回退）；与 insert 同事务保证崩溃一致性
    await queryable.query(
      `UPDATE events_cursor
       SET last_seen_event_id = GREATEST(last_seen_event_id, $1), updated_at = now()
       WHERE id = 1`,
      [frame.eventId],
    );

    return (rowCount ?? 0) > 0;
  }

  /** 读取当前游标（重连时 since=last_seen_event_id 补拉，独占语义）。 */
  async getCursor(): Promise<number> {
    const { rows } = await this.pool.query<{ last_seen_event_id: string }>(
      'SELECT last_seen_event_id FROM events_cursor WHERE id = 1',
    );
    const row = rows[0];
    if (row === undefined) throw new Error('events_cursor 单行缺失（迁移 0006 保证存在）');
    return Number(row.last_seen_event_id);
  }

  /** 取待处理事件（按 event_id 升序；乱序容忍由 handler 的 upsert 语义保证）。 */
  async listPending(limit: number): Promise<InboxRow[]> {
    const { rows } = await this.pool.query<DbInboxRow>(
      `SELECT * FROM events_inbox
       WHERE processed_at IS NULL
       ORDER BY event_id
       LIMIT $1`,
      [limit],
    );
    return rows.map(fromDb);
  }

  /** 处理成功：置 processed_at（必须在 handler 的业务事务内调用）。 */
  async markProcessed(queryable: Queryable, eventId: number): Promise<void> {
    await queryable.query(
      'UPDATE events_inbox SET processed_at = now() WHERE event_id = $1',
      [eventId],
    );
  }

  /**
   * 处理失败：attempts+1 + 记录 last_error，**不置 processed_at**（下轮重试）。
   * 在业务事务回滚后的独立事务内调用（与 inconsistency web_event 同事务）。
   */
  async markAttemptFailed(
    queryable: Queryable,
    eventId: number,
    errorMessage: string,
  ): Promise<void> {
    await queryable.query(
      `UPDATE events_inbox
       SET attempts = attempts + 1, last_error = $2
       WHERE event_id = $1`,
      [eventId, errorMessage],
    );
  }
}
