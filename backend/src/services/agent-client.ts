/**
 * Agent 服务 HTTP 客户端（规划 05 §1）。
 *
 * 封装对 agent-mock 的调用：
 *   - callTurn: POST /agent/turn，带 10-15s 超时，代际号丢弃迟到响应
 *   - callAudit: POST /agent/audit
 */
import type { LoggerLike } from './gateway-client.js';

/** Agent 工具定义。 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** Agent 消息内容块。 */
export type AgentContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error?: boolean };

/** Agent 消息。 */
export interface AgentMessage {
  readonly role: 'user' | 'assistant';
  readonly content: AgentContentBlock[] | string;
}

/** /agent/turn 成功响应。 */
export interface TurnResponse {
  readonly id: string;
  readonly model: string;
  readonly stop_reason: 'tool_use' | 'end_turn';
  readonly content: AgentContentBlock[];
}

/** callTurn 的结果：成功 / 协议错误 / 超时。 */
export type TurnResult =
  | { kind: 'ok'; response: TurnResponse }
  | { kind: 'protocol_error'; code: 'BAD_JSON' | 'TURN_TIMEOUT'; raw: string };

/** /agent/audit 结果。 */
export type AuditResult =
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }
  | { kind: 'error'; message: string };

export interface AgentClientOptions {
  readonly turnTimeoutMs?: number;
}

export class AgentClient {
  private generation = 0;

  constructor(
    private readonly agentUrl: string,
    private readonly log: LoggerLike,
    private readonly options: AgentClientOptions = {},
  ) {}

  /**
   * 调用 /agent/turn。
   * 超时返回 TURN_TIMEOUT；迟到的响应通过代际号丢弃。
   */
  async callTurn(
    runId: string,
    tools: AgentTool[],
    messages: AgentMessage[],
  ): Promise<TurnResult> {
    const myGen = ++this.generation;
    const timeoutMs = this.options.turnTimeoutMs ?? 12000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.agentUrl}/agent/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, tools, messages }),
        signal: controller.signal,
      });

      // 代际号检查：若期间又发起了新 turn，丢弃迟到响应
      if (myGen !== this.generation) {
        return { kind: 'protocol_error', code: 'TURN_TIMEOUT', raw: 'stale response' };
      }

      const raw = await res.text();
      if (!res.ok) {
        return { kind: 'protocol_error', code: 'BAD_JSON', raw };
      }
      return this.parseTurnResponse(raw);
    } catch (err) {
      if (myGen !== this.generation) {
        return { kind: 'protocol_error', code: 'TURN_TIMEOUT', raw: 'stale response' };
      }
      // AbortError = 超时
      if (err instanceof Error && err.name === 'AbortError') {
        return { kind: 'protocol_error', code: 'TURN_TIMEOUT', raw: `timeout after ${timeoutMs}ms` };
      }
      this.log.warn({ runId, err }, 'agent: /agent/turn 调用异常');
      return { kind: 'protocol_error', code: 'BAD_JSON', raw: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 解析 /agent/turn 响应体，校验形状合法性。
   * BAD_JSON 三种情形：非合法 JSON / 形状不符（缺 stop_reason、块数≠1、stop_reason 与块类型不一致）。
   */
  private parseTurnResponse(raw: string): TurnResult {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }

    if (typeof body !== 'object' || body === null) {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    const rec = body as Record<string, unknown>;

    const stopReason = rec['stop_reason'];
    const content = rec['content'];
    if (typeof stopReason !== 'string' || !Array.isArray(content)) {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    if (content.length !== 1) {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }

    const block = content[0] as Record<string, unknown>;
    const blockType = block['type'];

    // stop_reason 与块类型必须一致
    if (stopReason === 'tool_use' && blockType !== 'tool_use') {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    if (stopReason === 'end_turn' && blockType !== 'tool_use' && blockType !== 'text') {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }

    // 基本字段校验
    if (blockType === 'tool_use') {
      if (typeof block['id'] !== 'string' || typeof block['name'] !== 'string') {
        return { kind: 'protocol_error', code: 'BAD_JSON', raw };
      }
    }

    return { kind: 'ok', response: body as TurnResponse };
  }

  /** 调用 /agent/audit。 */
  async callAudit(text: string, groupId: string): Promise<AuditResult> {
    try {
      const res = await fetch(`${this.agentUrl}/agent/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, groupId }),
      });
      if (!res.ok) {
        return { kind: 'error', message: `audit HTTP ${res.status}` };
      }
      const body = await res.json() as Record<string, unknown>;
      const verdict = body['verdict'];
      const reason = typeof body['reason'] === 'string' ? body['reason'] : '';
      if (verdict === 'pass') return { kind: 'pass' };
      if (verdict === 'fail') return { kind: 'fail', reason };
      return { kind: 'error', message: `invalid verdict: ${String(verdict)}` };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
}
