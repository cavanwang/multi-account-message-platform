/**
 * web_events 入队 helper。
 *
 * web_events 是面向前端的事件流（规划 02 §2.10）：
 *   - 全局单调 seq（BIGSERIAL），供切片 4 的 WebSocket 推送与断线 sinceSeq 补齐
 *   - 必须在**业务事务内**调用（传入事务持有的 PoolClient），保证
 *     "推给前端的状态事件对应已持久化的状态"（INV-5）
 *   - 非关键路径（如转移提交后的通知）也可直接传 Pool，此时为独立自动提交事务
 */
import type { Pool, PoolClient } from 'pg';

/** 任意可执行 query 的对象：连接池或事务连接。 */
export type Queryable = Pool | PoolClient;

/** 前端事件行。 */
export interface WebEventRow {
  readonly seq: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

interface DbWebEventRow {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

/**
 * 入队一条前端事件。
 * @param queryable 事务连接（推荐）或连接池
 * @param type 事件类型（如 account_status_changed / account_terminal）
 * @param payload 事件负载，会被序列化为 JSONB
 */
export async function enqueueWebEvent(
  queryable: Queryable,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await queryable.query(
    'INSERT INTO web_events (type, payload) VALUES ($1, $2::jsonb)',
    [type, JSON.stringify(payload)],
  );
}

// -------------------------------------------------------------------------
// WebSocket 推送用（规划 04 §4，任务 4.12 / 4.13）
// -------------------------------------------------------------------------

/**
 * 取 seq 严格大于 afterSeq 的事件，按 seq 升序，最多 limit 条。
 * 用于：(1) ws-publisher 轮询推送；(2) 连接时 sinceSeq 补发。
 */
export async function fetchEventsAfter(
  pool: Pool,
  afterSeq: number,
  limit: number,
): Promise<WebEventRow[]> {
  const { rows } = await pool.query<DbWebEventRow>(
    `SELECT seq, type, payload, created_at
     FROM web_events
     WHERE seq > $1
     ORDER BY seq ASC
     LIMIT $2`,
    [afterSeq, Math.max(1, limit)],
  );
  return rows.map<WebEventRow>((r) => ({
    // BIGINT 在 pg 驱动中以字符串返回，转成 number（本项目 seq 不会溢出安全整数范围）
    seq: Number(r.seq),
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

/**
 * 更新 ws_push_cursor 的 last_pushed_seq。
 * ws_push_cursor 表只有一行（id=1），用 ON CONFLICT 保证幂等。
 */
export async function updatePushCursor(pool: Pool, seq: number): Promise<void> {
  await pool.query(
    `INSERT INTO ws_push_cursor (id, last_pushed_seq) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_pushed_seq = $1`,
    [seq],
  );
}

/** 读取 ws_push_cursor.last_pushed_seq（首次为 0）。 */
export async function getPushCursor(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ last_pushed_seq: string | number }>(
    'SELECT last_pushed_seq FROM ws_push_cursor WHERE id = 1',
  );
  // BIGINT 以字符串返回
  return rows[0] !== undefined ? Number(rows[0].last_pushed_seq) : 0;
}
