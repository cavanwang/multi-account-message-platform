/**
 * message_failed 事件 handler：网关把我们自己发出的消息判为失败。
 *
 * 语义：
 *  - 按 clientMsgId 找 outbox；CAS accepted/unknown → failed（failCode=事件 code）；
 *  - 事务内入队 web_event 'message_failed'（INV-5）。
 */
import { OutboxRepo } from '../../repos/outbox.js';
import { enqueueWebEvent } from '../../repos/web-events.js';
import type { HandlerContext } from './types.js';
import { asRecord, reqStr } from './types.js';

export async function handleMessageFailed(ctx: HandlerContext, payload: unknown): Promise<void> {
  const rec = asRecord(payload, 'message_failed');
  const clientMsgId = reqStr(rec, 'clientMsgId', 'message_failed');
  const code = reqStr(rec, 'code', 'message_failed');

  const outboxRepo = new OutboxRepo(ctx.pool);
  const outbox = await outboxRepo.findByClientMsgId(clientMsgId);
  if (outbox === undefined) {
    throw new Error(`message_failed: 找不到 outbox clientMsgId=${clientMsgId}`);
  }

  // 状态机保护：只接受 accepted/unknown → failed（防止终态/queued 被事件"复活"，P1）
  if (outbox.deliveryStatus !== 'accepted' && outbox.deliveryStatus !== 'unknown') {
    ctx.log.debug(
      { clientMsgId, status: outbox.deliveryStatus, code },
      'handler: outbox 状态不是 accepted/unknown，跳过 message_failed 处理',
    );
    return;
  }

  // CAS：accepted / unknown → failed
  const updated = await outboxRepo.transitionCAS(
    ctx.client,
    outbox.id,
    outbox.version,
    'failed',
    { failCode: code },
  );

  // 重复事件 CAS 返回 null 时不入队 web_event（P2：防重复推送）
  if (updated !== null) {
    ctx.log.info(
      { clientMsgId, outboxId: outbox.id, failCode: code },
      'handler: outbox → failed',
    );
    await enqueueWebEvent(ctx.client, 'message_failed', {
      clientMsgId,
      groupId: outbox.groupId,
      failCode: code,
      source: 'gateway_event',
    });
  } else {
    ctx.log.debug(
      { clientMsgId, outboxId: outbox.id, failCode: code },
      'handler: CAS 冲突（可能重复事件），跳过 outbox 更新与 web_event',
    );
  }
}
