/**
 * message 事件 handler：群内有新消息（含自己发出的消息回流）。
 *
 * 语义（规划 03 §2.6）：
 *  - senderPlatformUserId 命中 group_members → isOwn = true（服务账号自己发的消息）；
 *  - upsert messages(group_id, msg_id)（PK 唯一，一行原则）；
 *  - isOwn = true → **不触发 agent**（切片 5 才实现 agent，这里只注释占位）；
 *  - 事务内入队 web_event 'message_received'（INV-5）。
 *
 * 乱序/补投容忍：重复收到同一 (groupId,msgId) → ON CONFLICT DO UPDATE，
 * 最后写入者覆盖 text/sent_at；不丢弃"太旧"的消息。
 */
import { GroupRepo } from '../../repos/groups.js';
import { upsertMessage } from '../../repos/messages.js';
import { enqueueWebEvent } from '../../repos/web-events.js';
import type { HandlerContext } from './types.js';
import { asRecord, reqStr, nullableStr, reqDate } from './types.js';

export async function handleMessage(ctx: HandlerContext, payload: unknown): Promise<void> {
  const rec = asRecord(payload, 'message');
  const gatewayGroupId = reqStr(rec, 'groupId', 'message');
  const msgId = reqStr(rec, 'msgId', 'message');
  const senderPlatformUserId = nullableStr(rec, 'senderPlatformUserId');
  const text = reqStr(rec, 'text', 'message');
  const sentAt = reqDate(rec, 'sentAt', 'message');
  const mediaUrl = nullableStr(rec, 'mediaUrl') ?? undefined;

  const groupRepo = new GroupRepo(ctx.pool);

  // 网关 groupId → 内部 UUID
  const group = await groupRepo.findByGatewayGroupId(gatewayGroupId, ctx.client);
  if (group === undefined) {
    throw new Error(`message: 群不存在（gatewayGroupId=${gatewayGroupId}）`);
  }

  // isOwn：sender 是否为该群的服务账号成员
  const isOwn = senderPlatformUserId !== null
    ? await groupRepo.isMemberByPlatformUserId(ctx.client, group.id, senderPlatformUserId)
    : false;

  // upsert 时间线行（一行原则）
  await upsertMessage(ctx.client, {
    groupId: group.id,
    msgId,
    senderPlatformUserId,
    isOwn,
    text,
    sentAt,
    mediaUrl: mediaUrl ?? null,
  });

  // 自身消息不触发 agent（切片 5 占位）
  // if (!isOwn) { agentTrigger(...) }

  await enqueueWebEvent(ctx.client, 'message_received', {
    groupId: group.id,
    msgId,
    senderPlatformUserId,
    isOwn,
    text,
    sentAt: sentAt.toISOString(),
    mediaUrl: mediaUrl ?? null,
  });

  ctx.log.info(
    { groupId: group.id, msgId, isOwn },
    'handler: message 事件已处理',
  );
}
