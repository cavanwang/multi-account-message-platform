/**
 * 消息时间线仓储层：messages 表的 SQL 只出现在这里。
 *
 * 核心语义（规划 03 §2.5 / §2.6）：
 *  - **一条消息只有一行**：PK (group_id, msg_id)；
 *    message_sent（自己发的）与回流的 message 事件 upsert 同一行；
 *  - **乱序/补投容忍**：upsert 不做"太旧就丢弃"判断，最后写入者覆盖
 *    text/sent_at/media_url（消费按 event_id 升序，事件序即权威序）；
 *  - is_own 一旦为 true 不再回翻（message_sent 先写 true，回流 message
 *    可能因成员表时序判定为 false，取 OR 保住 true）。
 */
import type { PoolClient } from 'pg';

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
