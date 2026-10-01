/**
 * 消息时间线仓储层：messages 表的 SQL 只出现在这里。
 *
 * 核心语义（规划 03 §2.5 / §2.6、规划 04 §3.1）：
 *  - **一条消息只有一行**：PK (group_id, msg_id)；
 *    message_sent（自己发的）与回流的 message 事件 upsert 同一行；
 *  - **乱序/补投容忍**：upsert 不做"太旧就丢弃"判断，最后写入者覆盖
 *    text/sent_at/media_url（消费按 event_id 升序，事件序即权威序）；
 *  - is_own 一旦为 true 不再回翻（message_sent 先写 true，回流 message
 *    可能因成员表时序判定为 false，取 OR 保住 true）；
 *  - **时间线分页**：复合游标 (sentAt, sortKey)，sortKey = msg_id（已落地）
 *    或 client_msg_id（未落地）；UNION ALL 合并已落地与未落地的出站消息。
 */
import type { Pool, PoolClient } from 'pg';

export interface MessageUpsert {
  readonly groupId: string;
  /** 网关 msgId。 */
  readonly msgId: string;
  /** 自己发的才有（关联 outbox_messages.client_msg_id）。 */
  readonly clientMsgId?: string | null;
  /** DB 列 NOT NULL；外部/系统消息为 null 时落库为空串。 */
  readonly senderPlatformUserId: string | null;
  readonly isOwn: boolean;
  readonly text: string;
  readonly sentAt: Date;
  readonly mediaUrl?: string | null;
}

/**
 * upsert 一条消息（必须在调用方事务内调用，与 web_event 同事务，INV-5）。
 *
 * 冲突时更新 text/sent_at/media_url（最后写入者胜），
 * is_own 取 OR（true 不回翻），client_msg_id 只填不清。
 */
export async function upsertMessage(client: PoolClient, msg: MessageUpsert): Promise<void> {
  await client.query(
    `INSERT INTO messages
       (msg_id, group_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at, media_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (group_id, msg_id) DO UPDATE SET
       text      = EXCLUDED.text,
       sent_at   = EXCLUDED.sent_at,
       media_url = COALESCE(EXCLUDED.media_url, messages.media_url),
       is_own    = messages.is_own OR EXCLUDED.is_own,
       -- sender 只填不清：message_sent 先写空串，回流 message 用真实 sender 补全
       sender_platform_user_id = CASE
         WHEN EXCLUDED.sender_platform_user_id <> '' THEN EXCLUDED.sender_platform_user_id
         ELSE messages.sender_platform_user_id
       END,
       client_msg_id = COALESCE(EXCLUDED.client_msg_id, messages.client_msg_id)`,
    [
      msg.msgId,
      msg.groupId,
      msg.clientMsgId ?? null,
      msg.senderPlatformUserId ?? '',
      msg.isOwn,
      msg.text,
      msg.sentAt,
      msg.mediaUrl ?? null,
    ],
  );
}

// -------------------------------------------------------------------------
// C1 媒体：本地文件路径维护（5.25）
// -------------------------------------------------------------------------

/** 查一条消息已下载的本地路径；未下载返回 null。 */
export async function getMessageLocalPath(
  queryable: Pool | PoolClient,
  groupId: string,
  msgId: string,
): Promise<string | null> {
  const { rows } = await queryable.query<{ local_file_path: string | null }>(
    `SELECT local_file_path FROM messages
     WHERE group_id = $1 AND msg_id = $2`,
    [groupId, msgId],
  );
  return rows[0]?.local_file_path ?? null;
}

/** 下载成功后回写本地路径与下载时刻。 */
export async function setMessageLocalFile(
  client: PoolClient,
  groupId: string,
  msgId: string,
  filePath: string,
): Promise<void> {
  await client.query(
    `UPDATE messages
       SET local_file_path = $1, media_downloaded_at = now()
     WHERE group_id = $2 AND msg_id = $3`,
    [filePath, groupId, msgId],
  );
}

/** 清理删除文件后：置空路径（不留指向已删文件的记录）。 */
export async function clearMessageLocalFile(
  client: PoolClient,
  groupId: string,
  msgId: string,
): Promise<void> {
  await client.query(
    `UPDATE messages SET local_file_path = NULL
     WHERE group_id = $1 AND msg_id = $2`,
    [groupId, msgId],
  );
}

/** 到期媒体候选：已下载且下载时刻早于 cutoff 的消息。 */
export interface ExpiredMediaRow {
  readonly groupId: string;
  readonly msgId: string;
  readonly localFilePath: string;
}

export async function listExpiredMedia(
  pool: Pool,
  cutoff: Date,
): Promise<ExpiredMediaRow[]> {
  const { rows } = await pool.query<{
    group_id: string;
    msg_id: string;
    local_file_path: string;
  }>(
    `SELECT group_id, msg_id, local_file_path FROM messages
     WHERE local_file_path IS NOT NULL AND media_downloaded_at < $1
     ORDER BY media_downloaded_at ASC`,
    [cutoff],
  );
  return rows.map((r) => ({
    groupId: r.group_id,
    msgId: r.msg_id,
    localFilePath: r.local_file_path,
  }));
}

// -------------------------------------------------------------------------
// 时间线分页（规划 04 §3.1，任务 4.10）
// -------------------------------------------------------------------------

/** 时间线条目。 */
export interface TimelineItem {
  /** 网关 msgId；未落地的出站消息为 null。 */
  readonly msgId: string | null;
  /** 自己发的才有（关联 outbox）。 */
  readonly clientMsgId: string | null;
  readonly senderPlatformUserId: string;
  readonly isOwn: boolean;
  readonly text: string;
  readonly sentAt: Date;
  /** 仅自己的消息有意义；非自己的消息为 null。 */
  readonly deliveryStatus: string | null;
  /** 仅自己的消息有意义；非自己的消息为 null。 */
  readonly failCode: string | null;
}

/** 解码后的游标。 */
export interface TimelineCursor {
  readonly sentAt: Date;
  /** sortKey：已落地用 msg_id，未落地用 client_msg_id。 */
  readonly sortKey: string;
}

/**
 * 将游标编码为不透明字符串（base64url）。对外不承诺格式。
 * 格式：`<epochMillis>:<sortKey>`。
 */
export function encodeCursor(cursor: TimelineCursor): string {
  const raw = `${cursor.sentAt.getTime()}:${cursor.sortKey}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * 解码游标。非法格式返回 null（调用方应当作"无游标"处理，即首页）。
 */
export function decodeCursor(encoded: string | null | undefined): TimelineCursor | null {
  if (encoded === null || encoded === undefined || encoded === '') return null;
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const colonIdx = raw.indexOf(':');
    if (colonIdx <= 0) return null;
    const epochStr = raw.slice(0, colonIdx);
    const sortKey = raw.slice(colonIdx + 1);
    const epoch = Number(epochStr);
    if (!Number.isFinite(epoch) || sortKey === '') return null;
    return { sentAt: new Date(epoch), sortKey };
  } catch {
    return null;
  }
}

interface DbTimelineRow {
  msg_id: string | null;
  client_msg_id: string | null;
  sender_platform_user_id: string;
  is_own: boolean;
  text: string;
  sent_at: Date;
  delivery_status: string | null;
  fail_code: string | null;
}

/**
 * 时间线分页查询。
 *
 * 数据来源（UNION ALL）：
 *   1. 已落地消息（messages 表）：LEFT JOIN outbox 取 deliveryStatus/failCode。
 *      非自己的消息 client_msg_id 为 null → outbox 不匹配 → delivery/fail 为 null。
 *   2. 未落地的出站消息（outbox 无 gateway_msg_id，状态 queued/accepted/unknown）：
 *      sentAt 用 accepted_at（受理时刻），无则 created_at；is_own=true。
 *
 * 游标：复合 (sentAt, sortKey)，sortKey = COALESCE(msg_id, client_msg_id::text)。
 * 取 limit+1 条判断是否有下一页；返回 items + nextCursor（无下一页为 null）。
 */
export async function listTimeline(
  pool: Pool,
  groupId: string,
  cursor: TimelineCursor | null,
  limit: number,
): Promise<{ items: TimelineItem[]; nextCursor: string | null }> {
  const safeLimit = Math.max(1, Math.min(50, limit));

  const params: unknown[] = [groupId];
  let cursorClause = '';
  if (cursor !== null) {
    cursorClause = 'AND (t.sent_at, t.sort_key) < ($2, $3)';
    params.push(cursor.sentAt, cursor.sortKey);
  }
  params.push(safeLimit + 1);
  const limitIdx = params.length;

  const { rows } = await pool.query<DbTimelineRow>(
    `WITH timeline AS (
       -- 已落地消息
       SELECT
         m.msg_id,
         m.client_msg_id,
         m.sender_platform_user_id,
         m.is_own,
         m.text,
         m.sent_at,
         o.delivery_status,
         o.fail_code,
         m.msg_id AS sort_key
       FROM messages m
       LEFT JOIN outbox_messages o ON o.client_msg_id = m.client_msg_id
       WHERE m.group_id = $1

       UNION ALL

       -- 未落地的出站消息（网关尚未返回 msgId）
       SELECT
         NULL AS msg_id,
         o.client_msg_id,
         a.platform_user_id AS sender_platform_user_id,
         true AS is_own,
         o.text,
         COALESCE(o.accepted_at, o.created_at) AS sent_at,
         o.delivery_status,
         o.fail_code,
         o.client_msg_id::text AS sort_key
       FROM outbox_messages o
       JOIN accounts a ON a.id = o.account_id
       WHERE o.group_id = $1
         AND o.gateway_msg_id IS NULL
         AND o.delivery_status IN ('queued', 'accepted', 'unknown')
     )
     SELECT * FROM timeline t
     WHERE 1=1 ${cursorClause}
     ORDER BY t.sent_at DESC, t.sort_key DESC
     LIMIT $${limitIdx}`,
    params,
  );

  const hasMore = rows.length > safeLimit;
  const items = rows.slice(0, safeLimit).map<TimelineItem>((r) => ({
    msgId: r.msg_id,
    clientMsgId: r.client_msg_id,
    senderPlatformUserId: r.sender_platform_user_id,
    isOwn: r.is_own,
    text: r.text,
    sentAt: r.sent_at,
    deliveryStatus: r.delivery_status,
    failCode: r.fail_code,
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = items[items.length - 1]!;
    const sortKey = last.msgId ?? last.clientMsgId ?? '';
    nextCursor = encodeCursor({ sentAt: last.sentAt, sortKey });
  }

  return { items, nextCursor };
}
