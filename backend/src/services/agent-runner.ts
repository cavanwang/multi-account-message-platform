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
import type { AgentEndReason, AgentRunRepo, AgentRunStatus } from '../repos/agent-runs.js';
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
  // 重复 get_recent_messages 检测：记录上一次的入参 JSON
  let lastGetRecentInput: string | null = null;

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

    // ---- 崩溃恢复：检查最后一条 assistant tool_use 是否有对应 tool_result ----
    await recoverIncompleteToolUse(deps, client, run, messages);

    // 主循环
    while (run.status === 'running') {
      stepNo++;

      /**
       * run 终态统一出口：落库终态并发 §2.3 'agent_run' 前端事件
       * （{ runId, groupId, status, endReason }）。所有结束路径必须经此函数，
       * 避免漏发事件导致页面状态不刷新。
       */
      const finishRunWithEvent = async (
        status: AgentRunStatus,
        endReason: AgentEndReason,
        summary: string | null,
      ): Promise<void> => {
        await agentRunRepo.finishRun(client, runId, status, endReason, summary);
        await enqueueWebEvent(client, 'agent_run', {
          runId,
          groupId: run.groupId,
          status,
          endReason,
        });
      };

      // ---- 外部状态检查：群 unreachable 或 agentEnabled 关闭 → cancelled ----
      const groupCheck = await deps.groupRepo.findById(run.groupId);
      if (groupCheck === undefined || groupCheck.status === 'unreachable' || !groupCheck.agentEnabled) {
        const reason = groupCheck?.status === 'unreachable' ? 'group_unreachable' : 'agent_disabled';
        await finishRunWithEvent('cancelled', 'cancelled', null);
        log.info({ runId, reason }, 'agent: 群不可达或 agent 已关闭，run cancelled');
        return;
      }

      // ---- 预算检查 ----
      if (stepNo > MAX_STEPS) {
        await finishRunWithEvent('failed', 'budget_exhausted', null);
        log.info({ runId }, 'agent: 超出 12 步预算，failed');
        return;
      }

      const elapsed = Date.now() - runStart + run.accumulatedMs;
      if (elapsed > MAX_WALL_CLOCK_MS) {
        await finishRunWithEvent('failed', 'wall_clock', null);
        log.info({ runId, elapsed }, 'agent: 超出 60s 墙钟，failed');
        return;
      }

      if (consecutiveProtocolErrors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
        await finishRunWithEvent('failed', 'protocol_errors', null);
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
        await finishRunWithEvent('finished', 'final', summary);
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
          toolResult = await executeTool(deps, client, run, block, lastGetRecentInput);
          // 更新 get_recent_messages 入参记录
          if (block.name === 'get_recent_messages') {
            lastGetRecentInput = JSON.stringify(block.input);
          } else if (block.name === 'send_message' || block.name === 'kick_user') {
            // 其他工具重置，避免误判
            lastGetRecentInput = null;
          }
        } catch (err) {
          if (err instanceof AuditBlockedError) {
            // run → blocked，发 agent_run 事件通知操作员（页面 3 醒目提示、页面 4 可见）
            await finishRunWithEvent('blocked', 'audit_blocked', null);
            log.info({ runId }, 'agent: 审计连续失败，run blocked');
            return;
          }
          throw err;
        }

        // 第 1 类协议错误（UNKNOWN_TOOL / INVALID_INPUT）：正常追加 is_error tool_result
        // 其他错误（NO_AVAILABLE_ACCOUNT / SEND_FAILED 等）也以 is_error tool_result 返回
        const isError = toolResult.isError;
        const resultContent = stringifyWithSizeLimit(toolResult.content, MAX_TOOL_RESULT_BYTES);
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
          resultSummary: truncateChars(resultContent, 200),
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

/**
 * 崩溃恢复：检查 messages 末尾是否有未配对的 assistant tool_use。
 * 若有，根据 agent_tool_calls 状态判定是否已执行，回填 tool_result 或重放。
 * 绝不重放已生效的调用（INV-3）。
 */
async function recoverIncompleteToolUse(
  deps: AgentRunnerDeps,
  client: PoolClient,
  run: { id: string; groupId: string },
  messages: AgentMessage[],
): Promise<void> {
  // 找最后一条 assistant 消息中的 tool_use 块
  let lastToolUse: Extract<AgentContentBlock, { type: 'tool_use' }> | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const toolUse = blocks.find((b): b is Extract<AgentContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (toolUse !== undefined) {
      lastToolUse = toolUse;
      break;
    }
  }
  if (lastToolUse === null) return;

  // 检查是否已有对应的 tool_result
  const hasResult = messages.some((m) => {
    if (m.role !== 'user') return false;
    const blocks = Array.isArray(m.content) ? m.content : [];
    return blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === lastToolUse!.id);
  });
  if (hasResult) return;

  // 未配对 → 查 agent_tool_calls 判定
  const toolCall = await deps.agentRunRepo.getToolCallByToolUseId(client, run.id, lastToolUse.id);

  let result: ToolExecutionResult;
  if (toolCall !== undefined && toolCall.state === 'executed') {
    // 已执行 → 查 outbox 当前状态回填
    const outbox = toolCall.outboxId !== null
      ? await deps.outboxRepo.findById(toolCall.outboxId)
      : undefined;
    const status = outbox?.deliveryStatus ?? 'unknown';
    result = { content: { status, clientMsgId: toolCall.idempotencyKey, recovered: true }, isError: false };
  } else if (toolCall !== undefined && toolCall.state === 'pending_execution') {
    // pending_execution → 检查 outbox 是否已存在（crash 在 enqueue 之后、mark 之前）
    const outbox = await deps.outboxRepo.findByClientMsgId(toolCall.idempotencyKey);
    if (outbox !== undefined) {
      // 已入队但未标记 → 回填标记，返回状态
      await deps.agentRunRepo.markToolCallExecuted(client, run.id, toolCall.idempotencyKey, outbox.id);
      result = { content: { status: outbox.deliveryStatus, clientMsgId: toolCall.idempotencyKey, recovered: true }, isError: false };
    } else {
      // 未入队 → 重放执行
      result = await executeTool(deps, client, run, lastToolUse, null);
    }
  } else {
    // 无记录 → 重放执行（crash 在 recordToolCall 之前）
    result = await executeTool(deps, client, run, lastToolUse, null);
  }

  // 回填 tool_result 到 messages 和 DB
  const resultContent = stringifyWithSizeLimit(result.content, MAX_TOOL_RESULT_BYTES);
  const toolResultBlock: AgentContentBlock = {
    type: 'tool_result',
    tool_use_id: lastToolUse.id,
    content: resultContent,
    is_error: result.isError,
  };
  messages.push({ role: 'user', content: [toolResultBlock] });
  await deps.agentRunRepo.appendMessage(client, run.id, 'user', [toolResultBlock]);
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
  lastGetRecentInput: string | null,
): Promise<ToolExecutionResult> {
  const { name, input } = block;

  switch (name) {
    case 'get_recent_messages':
      return execGetRecentMessages(deps, run.groupId, input, lastGetRecentInput);
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

/**
 * get_recent_messages：查 messages 表最近 limit 条。
 * 连续第 2 次相同入参 → 返回 INVALID_INPUT 提示（规划 2.9）。
 */
async function execGetRecentMessages(
  deps: AgentRunnerDeps,
  groupId: string,
  input: Record<string, unknown>,
  lastGetRecentInput: string | null,
): Promise<ToolExecutionResult> {
  const currentInput = JSON.stringify(input);
  // 连续第 2 次相同入参 → 提示性 INVALID_INPUT
  if (lastGetRecentInput !== null && lastGetRecentInput === currentInput) {
    return {
      content: { error: 'INVALID_INPUT', hint: '重复调用 get_recent_messages，请基于已有信息决策' },
      isError: true,
      errorCode: 'INVALID_INPUT',
    };
  }

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

/** 截断字符串到 maxBytes 字节（用于 rawResponse 等非 JSON 字段）。 */
function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString('utf8');
}

/** 按字符数截断（用于 resultSummary ≤ 200 字）。 */
function truncateChars(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

/**
 * 序列化工具结果到 JSON，限制 maxBytes 字节。
 * 超出时追加 truncated:true 标志后再截断（对齐规划 2.9）。
 */
function stringifyWithSizeLimit(content: unknown, maxBytes: number): string {
  const raw = JSON.stringify(content);
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;
  // 注入 truncated 标志后再截断
  const obj = (typeof content === 'object' && content !== null)
    ? { ...(content as Record<string, unknown>), truncated: true }
    : { value: content, truncated: true };
  return truncate(JSON.stringify(obj), maxBytes);
}
