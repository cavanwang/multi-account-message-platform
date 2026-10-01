/**
 * Agent 运行主循环（规划 05 §2）。
 *
 * 职责：
 *   - 触发时创建 run，构建初始 messages；
 *   - 循环调 /agent/turn，解析响应，执行工具，追加结果；
 *   - 两类协议错误处理；
 *   - 预算上限（12 步 / 60s / 连续 3 次协议错误）；
 *   - 持久化每步与每条消息，支持崩溃恢复。
 *
 * F1 实现的工具：
 *   - get_recent_messages：查 messages 表
 *   - send_message：入队 outbox（审计在 F2 实现，当前直接通过）
 *   - kick_user：返回 POLICY_DENIED（F2 实现）
 *   - finish：结束 run
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AgentRunRepo } from '../repos/agent-runs.js';
import type { GroupRepo } from '../repos/groups.js';
import type { OutboxRepo } from '../repos/outbox.js';
import { listTimeline } from '../repos/messages.js';
import type { AccountRepo } from '../repos/accounts.js';
import type { AgentClient, AgentContentBlock, AgentMessage, AgentTool, TurnResult } from './agent-client.js';
import type { LoggerLike } from './gateway-client.js';
import type { GroupGateway } from './gateway-client.js';
import { enqueueWebEvent } from '../repos/web-events.js';

/** Agent 客户端接口（便于 mock 测试）。 */
export interface AgentClientLike {
  callTurn(runId: string, tools: AgentTool[], messages: AgentMessage[]): Promise<TurnResult>;
  callAudit(text: string, groupId: string): Promise<AuditResultLike>;
}

export type AuditResultLike =
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }
  | { kind: 'error'; message: string };

/** 预算上限常量。 */
const MAX_STEPS = 12;
const MAX_WALL_CLOCK_MS = 60_000;
const MAX_CONSECUTIVE_PROTOCOL_ERRORS = 3;
const MAX_TOOL_RESULT_BYTES = 8 * 1024;
const MAX_RAW_RESPONSE_BYTES = 2 * 1024;

/** 4 个工具的定义。 */
const TOOLS: AgentTool[] = [
  {
    name: 'get_recent_messages',
    description: '获取群最近消息',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } }, required: ['limit'] },
  },
  {
    name: 'send_message',
    description: '发送消息到群',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, idempotency_key: { type: 'string' } },
      required: ['text', 'idempotency_key'],
    },
  },
  {
    name: 'kick_user',
    description: '踢出群成员',
    input_schema: {
      type: 'object',
      properties: { platform_user_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['platform_user_id', 'reason'],
    },
  },
  {
    name: 'finish',
    description: '结束运行并给出总结',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

export interface AgentRunnerDeps {
  readonly pool: Pool;
  readonly agentRunRepo: AgentRunRepo;
  readonly groupRepo: GroupRepo;
  readonly outboxRepo: OutboxRepo;
  readonly accountRepo: AccountRepo;
  readonly agentClient: AgentClientLike;
  readonly groupGateway: GroupGateway;
  readonly log: LoggerLike;
}

/**
 * 启动一个 agent run（由 message 事件触发）。
 * 在独立事务中执行整个 run。
 */
export async function runAgent(deps: AgentRunnerDeps, runId: string): Promise<void> {
  const { pool, agentRunRepo, agentClient, log } = deps;
  const runStart = Date.now();
  let consecutiveProtocolErrors = 0;
  let stepNo = 0;
  const seenToolUseIds = new Set<string>();

  // 恢复：从 agent_run_messages 重建 messages 数组
  const client = await pool.connect();
  try {
    const run = await agentRunRepo.getRun(client, runId);
    if (run === undefined) {
      log.warn({ runId }, 'agent: run 不存在，跳过');
      return;
    }
    if (run.status !== 'running') {
      log.info({ runId, status: run.status }, 'agent: run 已结束，跳过');
      return;
    }

    const savedMessages = await agentRunRepo.loadMessages(client, runId);
    let messages: AgentMessage[] = savedMessages.map((m) => ({
      role: m.role,
      content: m.blocks as AgentContentBlock[],
    }));

    // 主循环
    while (run.status === 'running') {
      stepNo++;

      // ---- 预算检查 ----
      if (stepNo > MAX_STEPS) {
        await agentRunRepo.finishRun(client, runId, 'failed', 'budget_exhausted', null);
        log.info({ runId }, 'agent: 超出 12 步预算，failed');
        return;
      }

      const elapsed = Date.now() - runStart + run.accumulatedMs;
      if (elapsed > MAX_WALL_CLOCK_MS) {
        await agentRunRepo.finishRun(client, runId, 'failed', 'wall_clock', null);
        log.info({ runId, elapsed }, 'agent: 超出 60s 墙钟，failed');
        return;
      }

      if (consecutiveProtocolErrors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
        await agentRunRepo.finishRun(client, runId, 'failed', 'protocol_errors', null);
        log.info({ runId }, 'agent: 连续 3 次协议错误，failed');
        return;
      }

      // ---- 调 /agent/turn ----
      const result = await agentClient.callTurn(runId, TOOLS, messages);

      if (result.kind === 'protocol_error') {
        // 第 2 类协议错误：不追加 assistant 块，追加 user 的 PROTOCOL_ERROR 文本
        consecutiveProtocolErrors++;
        const errMsg = `PROTOCOL_ERROR ${result.code}: ${truncate(result.raw, MAX_RAW_RESPONSE_BYTES)}`;
        const userBlock: AgentContentBlock = { type: 'text', text: errMsg };
        messages.push({ role: 'user', content: [userBlock] });
        await agentRunRepo.appendMessage(client, runId, 'user', [userBlock]);
        await agentRunRepo.insertStep(client, runId, stepNo, {
          kind: 'protocol_error',
          toolUseId: null,
          name: null,
          input: null,
          resultSummary: null,
          isError: true,
          errorCode: result.code,
          auditVerdict: null,
          rawResponse: truncate(result.raw, MAX_RAW_RESPONSE_BYTES),
        });
        continue;
      }

      // 合法响应 → 清零连续协议错误计数
      consecutiveProtocolErrors = 0;
      const response = result.response;
      const block = response.content[0]!;

      // ---- finish / end_turn ----
      if (response.stop_reason === 'end_turn' || (block.type === 'tool_use' && block.name === 'finish')) {
        let summary: string | null = null;
        if (block.type === 'tool_use' && block.name === 'finish') {
          const input = block.input as Record<string, unknown>;
          summary = typeof input['summary'] === 'string' ? input['summary'] : null;
        }
        // 持久化 assistant 的 finish 块
        await agentRunRepo.appendMessage(client, runId, 'assistant', [block]);
        await agentRunRepo.insertStep(client, runId, stepNo, {
          kind: 'final',
          toolUseId: block.type === 'tool_use' ? block.id : null,
          name: block.type === 'tool_use' ? block.name : null,
          input: block.type === 'tool_use' ? block.input : null,
          resultSummary: summary,
          isError: false,
          errorCode: null,
          auditVerdict: null,
          rawResponse: null,
        });
        await agentRunRepo.finishRun(client, runId, 'finished', 'final', summary);
        log.info({ runId }, 'agent: run finished');
        return;
      }

      // ---- tool_use ----
      if (block.type === 'tool_use') {
        // 重复 tool_use.id 检测 → 第 2 类协议错误
        if (seenToolUseIds.has(block.id)) {
          consecutiveProtocolErrors++;
          const errMsg = `PROTOCOL_ERROR DUPLICATE_TOOL_USE_ID: ${block.id}`;
          const userBlock: AgentContentBlock = { type: 'text', text: errMsg };
          messages.push({ role: 'user', content: [userBlock] });
          await agentRunRepo.appendMessage(client, runId, 'user', [userBlock]);
          await agentRunRepo.insertStep(client, runId, stepNo, {
            kind: 'protocol_error',
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            resultSummary: null,
            isError: true,
            errorCode: 'DUPLICATE_TOOL_USE_ID',
            auditVerdict: null,
            rawResponse: null,
          });
          continue;
        }
        seenToolUseIds.add(block.id);

        // 持久化 assistant 的 tool_use 块
        await agentRunRepo.appendMessage(client, runId, 'assistant', [block]);

        // 执行工具（审计 3 次失败会抛 AuditBlockedError）
        let toolResult: ToolExecutionResult;
        try {
          toolResult = await executeTool(deps, client, run, block);
        } catch (err) {
          if (err instanceof AuditBlockedError) {
            // run → blocked，推事件通知操作员
            await agentRunRepo.finishRun(client, runId, 'blocked', 'audit_blocked', null);
            await enqueueWebEvent(client, 'agent_blocked', { runId, groupId: run.groupId, reason: 'audit_blocked' });
            log.info({ runId }, 'agent: 审计连续失败，run blocked');
            return;
          }
          throw err;
        }

        // 第 1 类协议错误（UNKNOWN_TOOL / INVALID_INPUT）：正常追加 is_error tool_result
        // 其他错误（NO_AVAILABLE_ACCOUNT / SEND_FAILED 等）也以 is_error tool_result 返回
        const isError = toolResult.isError;
        const resultContent = truncate(JSON.stringify(toolResult.content), MAX_TOOL_RESULT_BYTES);
        const toolResultBlock: AgentContentBlock = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultContent,
          is_error: isError,
        };
        messages.push({ role: 'user', content: [toolResultBlock] });
        await agentRunRepo.appendMessage(client, runId, 'user', [toolResultBlock]);
        await agentRunRepo.insertStep(client, runId, stepNo, {
          kind: 'tool_use',
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          resultSummary: truncate(resultContent, 200),
          isError,
          errorCode: toolResult.errorCode ?? null,
          auditVerdict: toolResult.auditVerdict ?? null,
          rawResponse: null,
        });

        // 累加耗时
        await agentRunRepo.tickAccumulated(client, runId, Date.now() - runStart);
        continue;
      }

      // text 块（不应出现，视为协议错误）
      consecutiveProtocolErrors++;
      const errMsg = 'PROTOCOL_ERROR UNEXPECTED_TEXT_BLOCK';
      const userBlock: AgentContentBlock = { type: 'text', text: errMsg };
      messages.push({ role: 'user', content: [userBlock] });
      await agentRunRepo.appendMessage(client, runId, 'user', [userBlock]);
      await agentRunRepo.insertStep(client, runId, stepNo, {
        kind: 'protocol_error',
        toolUseId: null,
        name: null,
        input: null,
        resultSummary: null,
        isError: true,
        errorCode: 'UNEXPECTED_TEXT_BLOCK',
        auditVerdict: null,
        rawResponse: null,
      });
    }
  } finally {
    client.release();
  }
}

/** 工具执行结果。 */
interface ToolExecutionResult {
  readonly content: unknown;
  readonly isError: boolean;
  readonly errorCode?: string;
  readonly auditVerdict?: string;
}

/** 审计连续 3 次失败 → run blocked。 */
class AuditBlockedError extends Error {
  constructor() {
    super('audit_blocked');
    this.name = 'AuditBlockedError';
  }
}

/** 执行单个工具调用。 */
async function executeTool(
  deps: AgentRunnerDeps,
  client: PoolClient,
  run: { id: string; groupId: string },
  block: Extract<AgentContentBlock, { type: 'tool_use' }>,
): Promise<ToolExecutionResult> {
  const { name, input } = block;

  switch (name) {
    case 'get_recent_messages':
      return execGetRecentMessages(deps, run.groupId, input);
    case 'send_message':
      return execSendMessage(deps, client, run, block.id, input);
    case 'kick_user':
      return execKickUser(deps, client, run, block.id, input);
    case 'finish':
      return { content: { ok: true }, isError: false };
    default:
      return { content: { error: 'UNKNOWN_TOOL' }, isError: true, errorCode: 'UNKNOWN_TOOL' };
  }
}

/**
 * 审计：最多 3 次，每次间隔 1s。
 * pass → 执行；fail → 返回 AUDIT_REJECTED；3 次 error → throw AuditBlockedError。
 */
async function runAudit(
  deps: AgentRunnerDeps,
  text: string,
  groupId: string,
): Promise<'pass' | 'fail'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await deps.agentClient.callAudit(text, groupId);
    if (result.kind === 'pass') return 'pass';
    if (result.kind === 'fail') return 'fail';
    // error → 重试
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new AuditBlockedError();
}

/** get_recent_messages：查 messages 表最近 limit 条。 */
async function execGetRecentMessages(
  deps: AgentRunnerDeps,
  groupId: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const limit = typeof input['limit'] === 'number' ? Math.min(100, Math.max(1, input['limit'])) : 10;
  const page = await listTimeline(deps.pool, groupId, null, limit);
  return {
    content: page.items.map((i) => ({
      msgId: i.msgId,
      text: i.text,
      senderPlatformUserId: i.senderPlatformUserId,
      sentAt: i.sentAt,
    })),
    isError: false,
  };
}

/**
 * send_message：幂等键去重 → 审计 → 选 online 账号 → 入队 outbox。
 * 被 AUDIT_REJECTED 拒绝的不占用幂等键。
 */
async function execSendMessage(
  deps: AgentRunnerDeps,
  client: PoolClient,
  run: { id: string; groupId: string },
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const text = typeof input['text'] === 'string' ? input['text'] : '';
  const idempotencyKey = typeof input['idempotency_key'] === 'string' ? input['idempotency_key'] : randomUUID();

  if (text === '') {
    return { content: { error: 'INVALID_INPUT', reason: 'text 为空' }, isError: true, errorCode: 'INVALID_INPUT' };
  }

  // 幂等键检查：同 run 同 key 已执行 → 返回当前状态，不审计不重发
  const existing = await deps.agentRunRepo.getToolCall(client, run.id, idempotencyKey);
  if (existing !== undefined && existing.state === 'executed' && existing.outboxId !== null) {
    const { rows } = await client.query<{ delivery_status: string }>(
      'SELECT delivery_status FROM outbox_messages WHERE id = $1',
      [existing.outboxId],
    );
    const status = rows[0]?.delivery_status ?? 'unknown';
    return { content: { status, clientMsgId: idempotencyKey, idempotent: true }, isError: false };
  }

  // 审计
  const verdict = await runAudit(deps, text, run.groupId);
  if (verdict === 'fail') {
    // 被拒不占用幂等键（不 recordToolCall）
    return { content: { error: 'AUDIT_REJECTED' }, isError: true, errorCode: 'AUDIT_REJECTED', auditVerdict: 'fail' };
  }

  // 选群里第一个 online 账号
  const members = await deps.groupRepo.listMembers(run.groupId);
  const accounts = await deps.accountRepo.findByUuids(members.map((m) => m.accountId));
  const onlineAccount = accounts.find((a) => a.status === 'online');
  if (onlineAccount === undefined) {
    return { content: { error: 'NO_AVAILABLE_ACCOUNT' }, isError: true, errorCode: 'NO_AVAILABLE_ACCOUNT' };
  }

  // 记录幂等键 → 入队 outbox → 标记已执行
  await deps.agentRunRepo.recordToolCall(client, run.id, idempotencyKey, toolUseId);
  const outbox = await deps.outboxRepo.enqueue(client, {
    groupId: run.groupId,
    accountId: onlineAccount.id,
    clientMsgId: idempotencyKey,
    text,
    origin: 'agent',
  });
  await deps.agentRunRepo.markToolCallExecuted(client, run.id, idempotencyKey, outbox.id);

  return { content: { status: 'queued', clientMsgId: idempotencyKey }, isError: false, auditVerdict: 'pass' };
}

/**
 * kick_user：autoKickEnabled 检查 → 选 creator/admin+online 账号 → 审计 → 调网关 kick。
 */
async function execKickUser(
  deps: AgentRunnerDeps,
  client: PoolClient,
  run: { id: string; groupId: string },
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const targetPlatformUserId = typeof input['platform_user_id'] === 'string' ? input['platform_user_id'] : '';
  const reason = typeof input['reason'] === 'string' ? input['reason'] : '';

  if (targetPlatformUserId === '') {
    return { content: { error: 'INVALID_INPUT', reason: 'platform_user_id 为空' }, isError: true, errorCode: 'INVALID_INPUT' };
  }

  // 群策略检查
  const group = await deps.groupRepo.findById(run.groupId);
  if (group === undefined) {
    return { content: { error: 'GROUP_NOT_FOUND' }, isError: true, errorCode: 'GROUP_NOT_FOUND' };
  }
  if (!group.autoKickEnabled) {
    return { content: { error: 'POLICY_DENIED' }, isError: true, errorCode: 'POLICY_DENIED' };
  }

  // 审计（kick 的 text 为 JSON）
  const auditText = JSON.stringify({ action: 'kick', platform_user_id: targetPlatformUserId, reason });
  const verdict = await runAudit(deps, auditText, run.groupId);
  if (verdict === 'fail') {
    return { content: { error: 'AUDIT_REJECTED' }, isError: true, errorCode: 'AUDIT_REJECTED', auditVerdict: 'fail' };
  }

  // 选 creator/admin 且 online 的账号
  const members = await deps.groupRepo.listMembers(run.groupId);
  const eligibleMembers = members.filter((m) => m.role === 'creator' || m.role === 'admin');
  const accounts = await deps.accountRepo.findByUuids(eligibleMembers.map((m) => m.accountId));
  const onlineAccount = accounts.find((a) => a.status === 'online');
  if (onlineAccount === undefined) {
    return { content: { error: 'NO_AVAILABLE_ACCOUNT' }, isError: true, errorCode: 'NO_AVAILABLE_ACCOUNT' };
  }

  // 调网关 kick
  const kickResult = await deps.groupGateway.kickMember(
    group.gatewayGroupId,
    onlineAccount.accountId,
    targetPlatformUserId,
  );

  if (kickResult.kind === 'ok') {
    return { content: { kicked: true }, isError: false, auditVerdict: 'pass' };
  }
  // 网络/业务错误 → SEND_FAILED（run 继续）
  return {
    content: { error: 'SEND_FAILED', code: kickResult.kind === 'error' ? kickResult.code : kickResult.code },
    isError: true,
    errorCode: 'SEND_FAILED',
    auditVerdict: 'pass',
  };
}

/** 截断字符串到 maxBytes 字节。 */
function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString('utf8');
}
