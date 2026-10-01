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
