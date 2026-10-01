/**
 * Agent 模拟器的契约类型（规划 05 §1，参照 requirements.md §3.2）。
 *
 * 输入输出严格对齐 Anthropic Messages API 形状，以便后端无缝切换到真实 Agent。
 */

/** 单个工具定义。 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** 消息内容块。 */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error?: boolean };

/** 一条消息。 */
export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: ContentBlock[] | string;
}

/** POST /agent/turn 请求体。 */
export interface TurnRequest {
  readonly runId: string;
  readonly tools: ToolDef[];
  readonly messages: Message[];
}

/** /agent/turn 成功响应（Anthropic Messages API 形状）。 */
export interface TurnResponse {
  readonly id: string;
  readonly model: string;
  readonly stop_reason: 'tool_use' | 'end_turn';
  readonly content: ContentBlock[];
}

/** POST /agent/audit 请求体。 */
export interface AuditRequest {
  readonly text: string;
  readonly groupId: string;
}

/** /agent/audit 响应。 */
export interface AuditResponse {
  readonly verdict: 'pass' | 'fail';
  readonly reason: string;
}

/** /agent/turn 错误码（规划 05 §1.2）。 */
export const AgentErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  TOOLS_INVALID: 'TOOLS_INVALID',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  OVERLOADED: 'OVERLOADED',
} as const;
export type AgentErrorCode = typeof AgentErrorCode[keyof typeof AgentErrorCode];

/** 坏行为模式（/_mock/behavior）。 */
export type BehaviorMode =
  | 'normal'
  | 'bad_json'
  | 'unknown_tool'
  | 'invalid_input'
  | 'duplicate_id'
  | 'retry_same_key'
  | 'never_finish'
  | 'repeat_get'
  | 'slow'
  | 'hang';

/** audit 模式（/_mock/audit）。 */
export type AuditMode =
  | 'pass'
  | 'fail'
  | 'error_500'
  | 'bad_json'
  | 'no_verdict'
  | 'invalid_verdict'
  | 'slow'
  | 'hang';
