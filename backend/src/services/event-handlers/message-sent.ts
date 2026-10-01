/**
 * message_sent 事件 handler：网关已把我们自己发出的消息落地。
 *
 * 语义：
 *  - 按 clientMsgId 找 outbox；CAS accepted/unknown → sent（回填 gatewayMsgId + sentAt）；
 *  - 同时 upsert messages 行（is_own=true，text 从 outbox 取）；
 *  - 一条消息只有一行：message_sent 与回流的 message 事件写同一 PK（group_id, msg_id）；
 *  - 事务内入队 web_event 'message_sent'（INV-5）。
 *
 * 注意：outbox 可能已是 sent（重复事件），CAS 会返回 null，此时仍尝试 upsert messages
 * （重复事件不影响最终状态）。
 */
import { OutboxRepo } from '../../repos/outbox.js';
import { SequenceRepo } from '../../repos/sequences.js';
import { scheduleNextStep } from '../sequence-runner.js';
import { upsertMessage } from '../../repos/messages.js';
import { enqueueWebEvent } from '../../repos/web-events.js';
import type { HandlerContext } from './types.js';
import { asRecord, reqStr, reqDate } from './types.js';

export async function handleMessageSent(ctx: HandlerContext, payload: unknown): Promise<void> {
  const rec = asRecord(payload, 'message_sent');
  const clientMsgId = reqStr(rec, 'clientMsgId', 'message_sent');
  const msgId = reqStr(rec, 'msgId', 'message_sent');
  const sentAt = reqDate(rec, 'sentAt', 'message_sent');

  const outboxRepo = new OutboxRepo(ctx.pool);
  const outbox = await outboxRepo.findByClientMsgId(clientMsgId);
  if (outbox === undefined) {
    // 找不到 outbox：可能是其他服务发出的消息，或事件超前于入库 → 抛错重试
    throw new Error(`message_sent: 找不到 outbox clientMsgId=${clientMsgId}`);
  }

  // 状态机保护：只接受 accepted/unknown → sent（防止终态/queued 被事件"复活"，P1）
  if (outbox.deliveryStatus !== 'accepted' && outbox.deliveryStatus !== 'unknown') {
    ctx.log.debug(
      { clientMsgId, status: outbox.deliveryStatus },
      'handler: outbox 状态不是 accepted/unknown，跳过 message_sent 处理',
    );
    // 仍回填 messages 行（一条消息只有一行，重复事件不影响最终状态）
    await upsertMessage(ctx.client, {
      groupId: outbox.groupId,
      msgId,
      clientMsgId,
      senderPlatformUserId: null,
      isOwn: true,
      text: outbox.text,
      sentAt,
    });
    return;
  }

  // CAS：accepted / unknown → sent
  const updated = await outboxRepo.transitionCAS(
    ctx.client,
    outbox.id,
    outbox.version,
    'sent',
    { gatewayMsgId: msgId, sentAt },
  );

  // 重复事件 CAS 返回 null 时只回填 messages，不入队 web_event（P2：防重复推送）
  if (updated !== null) {
    ctx.log.info(
      { clientMsgId, outboxId: outbox.id, msgId },
      'handler: outbox → sent',
    );
    await enqueueWebEvent(ctx.client, 'message_sent', {
      clientMsgId,
      groupId: outbox.groupId,
      msgId,
      sentAt: sentAt.toISOString(),
    });
  } else {
    ctx.log.debug(
      { clientMsgId, outboxId: outbox.id, msgId },
      'handler: CAS 冲突（可能重复事件），跳过 outbox 更新与 web_event',
    );
  }

  // 同时回填 messages 行（一行原则）
  await upsertMessage(ctx.client, {
    groupId: outbox.groupId,
    msgId,
    clientMsgId,
    senderPlatformUserId: null,
    isOwn: true,
    text: outbox.text,
    sentAt,
  });

  // 推进定时序列步骤：若此 outbox 属于某个 sequence step，标记 sent 并排下一步
  if (outbox.origin === 'sequence') {
    const sequenceRepo = new SequenceRepo(ctx.pool);
    const step = await sequenceRepo.findStepByOutboxId(ctx.client, outbox.id);
    if (step !== undefined && step.status === 'accepted') {
      await sequenceRepo.markStepSent(ctx.client, step.runId, step.stepIndex, sentAt);
      const run = await sequenceRepo.getRun(ctx.client, step.runId);
      if (run !== undefined) {
        const sequence = await sequenceRepo.getSequence(ctx.client, run.sequenceId);
        if (sequence !== undefined) {
          await scheduleNextStep(
            sequenceRepo,
            ctx.client,
            step.runId,
            sequence.steps,
            step.stepIndex,
            sentAt,
          );
        }
      }
    }
  }
}
