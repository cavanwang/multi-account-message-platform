/**
 * message 事件 handler：群内有新消息（含自己发出的消息回流）。
 *
 * 语义（规划 03 §2.6 + 05 §2.1）：
 *  - senderPlatformUserId 命中 group_members → isOwn = true（服务账号自己发的消息）；
 *  - upsert messages(group_id, msg_id)（PK 唯一，一行原则）；
 *  - isOwn = false 且 group.agentEnabled = true → 触发 agent run（创建 run 行，由 worker 执行）；
 *  - 事务内入队 web_event 'message'（§2.3 前端事件名，INV-5）；
 *  - 新建 run 时在同一事务入队 'agent_run'（status=running）。
 */
import { GroupRepo } from '../../repos/groups.js';
import { AgentRunRepo } from '../../repos/agent-runs.js';
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

  // 非自己消息 + agentEnabled → 触发 agent run
  let newAgentRunId: string | null = null;
  if (!isOwn && group.agentEnabled) {
    const agentRunRepo = new AgentRunRepo(ctx.pool);
    const run = await agentRunRepo.createRun(ctx.client, group.id);
    if (run === null) {
      // 已有 running run → 消息记为待处理
      // 找到当前 running 的 runId（唯一索引保证至多一个）
      const runs = await agentRunRepo.listByGroup(ctx.client, group.id);
      const runningRun = runs.find((r) => r.status === 'running');
      if (runningRun !== undefined) {
        await agentRunRepo.addPendingMessage(ctx.client, runningRun.id, msgId);
      }
    } else {
      // run !== null → 新 run 已创建，由 agent-runner-worker 轮询执行
      newAgentRunId = run.id;
    }
  }

  // 前端时间线实时追加事件（§2.3：message { groupId, msgId, isOwn }）
  await enqueueWebEvent(ctx.client, 'message', {
    groupId: group.id,
    msgId,
    senderPlatformUserId,
    isOwn,
    text,
    sentAt: sentAt.toISOString(),
    mediaUrl: mediaUrl ?? null,
  });

  // 新建 agent run → 同事务通知前端（run 行已落库，满足"事件对应已保存状态"）
  if (newAgentRunId !== null) {
    await enqueueWebEvent(ctx.client, 'agent_run', {
      runId: newAgentRunId,
      groupId: group.id,
      status: 'running',
      endReason: null,
    });
  }

  ctx.log.info(
    { groupId: group.id, msgId, isOwn },
    'handler: message 事件已处理',
  );
}
