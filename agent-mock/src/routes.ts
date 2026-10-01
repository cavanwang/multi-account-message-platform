/**
 * Agent 主路由：POST /agent/turn 与 POST /agent/audit。
 *
 * 设计要点（规划 05 §1）：
 *   - /agent/turn 严格校验 tools 必须恰好 4 个且 input_schema 合法；
 *   - 正常脚本：get_recent_messages → send_message → finish；
 *   - 坏行为模式通过 store.getBehaviorMode() 切换；
 *   - audit 默认 pass，坏模式通过 store.getAuditMode() 切换。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AuditRequest,
  AuditResponse,
  BehaviorMode,
  ToolDef,
  TurnRequest,
  TurnResponse,
} from './types.js';
import { AgentErrorCode } from './types.js';
import { readJsonBody, sendError, sendJson, sendRaw } from './lib/http.js';
import { store } from './store.js';

/** 4 个工具的名称（顺序固定）。 */
const EXPECTED_TOOL_NAMES = ['get_recent_messages', 'send_message', 'kick_user', 'finish'] as const;

// ---------------------------------------------------------------------------
// POST /agent/turn
// ---------------------------------------------------------------------------

export async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<TurnRequest>(req);
  if (body === null) {
    sendError(res, 400, AgentErrorCode.BAD_REQUEST, '请求体不是合法 JSON');
    return;
  }

  const { runId, tools, messages } = body;
  if (typeof runId !== 'string' || !Array.isArray(tools) || !Array.isArray(messages)) {
    sendError(res, 400, AgentErrorCode.BAD_REQUEST, 'runId/tools/messages 字段缺失或类型错误');
    return;
  }

  // 工具校验：恰好 4 个，名称正确，input_schema 合法
  const toolErr = validateTools(tools);
  if (toolErr !== null) {
    sendError(res, 400, AgentErrorCode.TOOLS_INVALID, toolErr);
    return;
  }

  const mode = store.getBehaviorMode();

  // hang 模式：永不响应
  if (mode === 'hang') {
    // 不写响应，连接保持
    return;
  }

  // slow 模式：延迟 8s
  if (mode === 'slow') {
    await new Promise((r) => setTimeout(r, 8000));
  }

  const session = store.getOrCreateSession(runId);
  const response = buildTurnResponse(session, mode, tools);

  // bad_json 模式：用 markdown 围栏包裹
  if (mode === 'bad_json') {
    sendRaw(res, 200, '```json\n' + JSON.stringify(response) + '\n```');
    return;
  }

  sendJson(res, 200, response);
}

/** 校验 tools 必须恰好 4 个、名称正确、input_schema 为合法 JSON Schema。 */
function validateTools(tools: ToolDef[]): string | null {
  if (tools.length !== 4) {
    return `tools 数量必须为 4，实际为 ${tools.length}`;
  }
  for (let i = 0; i < 4; i++) {
    const expected = EXPECTED_TOOL_NAMES[i]!;
    const actual = tools[i];
    if (actual?.name !== expected) {
      return `第 ${i} 个工具名应为 ${expected}，实际为 ${actual?.name ?? 'undefined'}`;
    }
    if (!isValidJsonSchema(actual.input_schema)) {
      return `工具 ${expected} 的 input_schema 不是合法 JSON Schema`;
    }
  }
  return null;
}

/** 极简 JSON Schema 合法性检查：必须是对象且有 type 字段。 */
function isValidJsonSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  return typeof s['type'] === 'string';
}

/**
 * 根据会话状态与坏行为模式构造 /agent/turn 响应。
 *
 * 正常脚本：
 *   - 首次（lastTool === null）→ get_recent_messages
 *   - 上一步是 get_recent_messages → send_message
 *   - 上一步是 send_message → finish
 */
function buildTurnResponse(
  session: { lastTool: string | null; usedToolIds: Set<string>; sendCount: number; lastIdempotencyKey: string | null },
  mode: BehaviorMode,
  _tools: ToolDef[],
): TurnResponse {
  switch (mode) {
    case 'unknown_tool': {
      // 只在首个 turn 调用一个不在 tools 列表中的工具，之后走正常脚本收尾。
      // 若每次都坏：后端回 is_error tool_result 后又收到 unknown_tool，
      // 毫秒级耗尽 12 步预算，run 只能 budget_exhausted，无法验证"坏一步后正常收尾"。
      if (session.lastTool === null) {
        return toolUseResponse(session, 'nonexistent_tool', {});
      }
      break;
    }
    case 'invalid_input': {
      // get_recent_messages 缺少必填参数 limit
      return toolUseResponse(session, 'get_recent_messages', {});
    }
    case 'duplicate_id': {
      // 重复使用一个已用过的 tool_use.id
      const existingId = [...session.usedToolIds][0] ?? 'dup-id-001';
      return {
        id: 'resp-dup',
        model: 'mock-agent',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: existingId, name: 'get_recent_messages', input: { limit: 10 } },
        ],
      };
    }
    case 'never_finish': {
      // 一直调 get_recent_messages，永不 finish
      return toolUseResponse(session, 'get_recent_messages', { limit: 10 });
    }
    case 'repeat_get': {
      // 连续相同入参调 get_recent_messages
      return toolUseResponse(session, 'get_recent_messages', { limit: 10 });
    }
    case 'retry_same_key': {
      // send_message 后用同一 idempotency_key 重试，最多 2 次（sendCount: 首次1 + 重试2），
      // 之后走正常脚本收尾。不能无限重试：后端幂等命中是纯 DB 查询，
      // 无限重试会毫秒级耗尽后端 12 步预算，run 以 budget_exhausted 告终。
      if (session.lastTool === 'send_message' && session.sendCount < 3) {
        const key = session.lastIdempotencyKey ?? 'ik-retry';
        return toolUseResponse(session, 'send_message', { text: '重试', idempotency_key: key });
      }
      // 否则走正常流程（send_message → finish）
      break;
    }
    default:
      break;
  }

  // ---- 正常脚本 ----
  if (session.lastTool === null) {
    return toolUseResponse(session, 'get_recent_messages', { limit: 10 });
  }
  if (session.lastTool === 'get_recent_messages') {
    const key = `ik-${session.sendCount + 1}`;
    return toolUseResponse(session, 'send_message', { text: '收到消息，已回复。', idempotency_key: key });
  }
  if (session.lastTool === 'send_message') {
    return finishResponse(session);
  }
  // 其他情况（如 finish 之后再被调用）→ finish
  return finishResponse(session);
}

/** 构造 tool_use 响应，并更新会话状态。 */
function toolUseResponse(
  session: { lastTool: string | null; usedToolIds: Set<string>; sendCount: number; lastIdempotencyKey: string | null },
  name: string,
  input: Record<string, unknown>,
): TurnResponse {
  const id = `tu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  session.usedToolIds.add(id);
  session.lastTool = name;
  if (name === 'send_message') {
    session.sendCount += 1;
    const key = typeof input['idempotency_key'] === 'string' ? input['idempotency_key'] : null;
    session.lastIdempotencyKey = key;
  }
  return {
    id: `resp-${id}`,
    model: 'mock-agent',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

/** 构造 finish（end_turn）响应。 */
function finishResponse(
  session: { lastTool: string | null },
): TurnResponse {
  session.lastTool = 'finish';
  return {
    id: `resp-finish-${Date.now()}`,
    model: 'mock-agent',
    stop_reason: 'end_turn',
    content: [
      { type: 'tool_use', id: `tu-finish-${Date.now()}`, name: 'finish', input: { summary: '已完成处理' } },
    ],
  };
}

// ---------------------------------------------------------------------------
// POST /agent/audit
// ---------------------------------------------------------------------------

export async function handleAudit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<AuditRequest>(req);
  if (body === null) {
    sendError(res, 400, AgentErrorCode.BAD_REQUEST, '请求体不是合法 JSON');
    return;
  }
  if (typeof body.text !== 'string' || typeof body.groupId !== 'string') {
    sendError(res, 400, AgentErrorCode.BAD_REQUEST, 'text 或 groupId 缺失');
    return;
  }

  const mode = store.getAuditMode();

  switch (mode) {
    case 'error_500':
      sendError(res, 500, AgentErrorCode.INTERNAL_ERROR, '模拟 audit 内部错误');
      return;
    case 'bad_json':
      sendRaw(res, 200, '```json\n{"verdict":"pass"}\n```');
      return;
    case 'no_verdict':
      sendJson(res, 200, { reason: '缺少 verdict 字段' });
      return;
    case 'invalid_verdict':
      sendJson(res, 200, { verdict: 'maybe', reason: '无效 verdict' });
      return;
    case 'slow':
      await new Promise((r) => setTimeout(r, 8000));
      sendJson(res, 200, { verdict: 'pass', reason: 'ok' } satisfies AuditResponse);
      return;
    case 'hang':
      // 不响应
      return;
    case 'fail':
      sendJson(res, 200, { verdict: 'fail', reason: '模拟审计不通过' } satisfies AuditResponse);
      return;
    case 'pass':
    default:
      sendJson(res, 200, { verdict: 'pass', reason: 'ok' } satisfies AuditResponse);
      return;
  }
}
