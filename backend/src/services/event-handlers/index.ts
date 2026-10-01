/**
 * 事件 handler 注册表：按 type 分发到对应的 handler。
 *
 * 职责：
 *  - 把 events_inbox 的 type 字段映射到处理函数；
 *  - 未知类型 → 只记录日志（不抛错），避免网关新增事件导致消费中断。
 */
import type { HandlerContext } from './types.js';
import { handleMessage } from './message.js';
import { handleMessageSent } from './message-sent.js';
import { handleMessageFailed } from './message-failed.js';
import { handleMemberJoined } from './member-joined.js';
import { handleMemberLeft } from './member-left.js';
import { handleAccountStatus } from './account-status.js';

const registry: Record<string, (ctx: HandlerContext, payload: unknown) => Promise<void>> = {
  message: handleMessage,
  message_sent: handleMessageSent,
  message_failed: handleMessageFailed,
  member_joined: handleMemberJoined,
  member_left: handleMemberLeft,
  account_status: handleAccountStatus,
};

/**
 * 派发事件到对应 handler。
 * @returns true=处理成功（置 processed_at）；false=未知类型（仅记录日志，也算"成功"，不阻塞后续）。
 */
export async function dispatch(ctx: HandlerContext, type: string, payload: unknown): Promise<boolean> {
  const handler = registry[type];
  if (handler === undefined) {
    ctx.log.warn({ eventType: type }, 'handler: 未知事件类型，跳过');
    return false;
  }
  await handler(ctx, payload);
  return true;
}
