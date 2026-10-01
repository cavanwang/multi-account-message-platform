/**
 * 真实 LLM Agent 客户端（C2 选做，规划 05 任务 5.26）。
 *
 * 默认部署仍走 agent-mock（离线、行为确定）；当 AGENT_PROVIDER=anthropic|openai
 * 且配置 AGENT_API_KEY 后，agent run 改由真实大模型驱动。
 *
 * 支持两种协议：
 *   - anthropic：Messages API（POST {base}/v1/messages）。其内容块模型
 *     （text / tool_use / tool_result、stop_reason）与本项目内部协议同源，基本直通；
 *   - openai：Chat Completions（POST {base}/chat/completions）。需要在
 *     "内部块协议 ↔ OpenAI messages/tools" 之间双向转换。
 *
 * 审计（callAudit）在真实提供方下不再有独立 mock 端点：用同一模型配合强约束
 * system prompt，要求只返回 {"verdict":"pass|fail","reason":"..."} JSON，
 * 解析失败按 error 处理（与 agent-mock 的 error_500 语义一致，计入 audit_blocked）。
 *
 * 错误映射与 mock 客户端一致：上游非 2xx / 响应不可解析 → BAD_JSON；
 * 超时/网络中断 → TURN_TIMEOUT，runner 已有的协议错误与预算逻辑原样复用。
 */
import type { LoggerLike } from './gateway-client.js';
import { AgentClient } from './agent-client.js';
import type {
  AgentContentBlock,
  AgentMessage,
  AgentTool,
  AuditResult,
  TurnResult,
} from './agent-client.js';

/** 真实模型 turn 超时：放宽到 30s（runner 墙钟预算 60s）。 */
const LLM_TURN_TIMEOUT_MS = 30_000;
/** 生成回复的 token 上限（agent 工具调用场景，1024 足够）。 */
const TURN_MAX_TOKENS = 1024;
/** 审计回复只需短 JSON。 */
const AUDIT_MAX_TOKENS = 200;
/** 当前 Anthropic API 版本头。 */
const ANTHROPIC_VERSION = '2023-06-01';

/** 审计 system prompt：强制 JSON 输出，模型自由发挥的空间最小。 */
const AUDIT_SYSTEM_PROMPT = [
  '你是群聊消息内容审计员。判断用户给出的"待发送文本"是否合规',
  '（不得包含违法、骚扰、仇恨或明显有害内容；普通寒暄与业务内容一律 pass）。',
  '你必须且只能返回一个 JSON 对象，不允许输出任何其他文字：',
  '{"verdict":"pass"} 或 {"verdict":"fail","reason":"简短理由"}',
].join('');

export interface LlmClientConfig {
  readonly provider: 'anthropic' | 'openai';
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/**
 * 真实 LLM 客户端。结构上满足 agent-runner 的 AgentClientLike
 * （不直接 import 该接口，避免 runner ↔ client 循环依赖）。
 */
export class RealLlmAgentClient {
  constructor(
    private readonly cfg: LlmClientConfig,
    private readonly log: LoggerLike,
  ) {}

  // -------------------------------------------------------------------------
  // callTurn
  // -------------------------------------------------------------------------

  async callTurn(
    runId: string,
    tools: AgentTool[],
    messages: AgentMessage[],
  ): Promise<TurnResult> {
    const { provider } = this.cfg;
    try {
      const body = provider === 'anthropic'
        ? this.buildAnthropicTurnBody(tools, messages)
        : this.buildOpenAiTurnBody(tools, messages);
      const res = await fetch(
        provider === 'anthropic'
          ? `${this.cfg.baseUrl}/v1/messages`
          : `${this.cfg.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: this.authHeaders(provider),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(LLM_TURN_TIMEOUT_MS),
        },
      );

      const raw = await res.text();
      if (!res.ok) {
        // 上游 4xx/5xx（含鉴权失败、限流）：按第 2 类协议错误喂回 runner
        return { kind: 'protocol_error', code: 'BAD_JSON', raw: truncateRaw(raw) };
      }
      return provider === 'anthropic'
        ? this.parseAnthropicResponse(raw)
        : this.parseOpenAiResponse(raw);
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { kind: 'protocol_error', code: 'TURN_TIMEOUT', raw: `timeout after ${LLM_TURN_TIMEOUT_MS}ms` };
      }
      this.log.warn({ runId, provider, err }, 'agent: 真实 LLM turn 调用异常');
      return { kind: 'protocol_error', code: 'BAD_JSON', raw: String(err) };
    }
  }

  /** Anthropic 请求体：内部协议与其 Messages API 同源，直接透传。 */
  private buildAnthropicTurnBody(tools: AgentTool[], messages: AgentMessage[]): Record<string, unknown> {
    return {
      model: this.cfg.model,
      max_tokens: TURN_MAX_TOKENS,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages,
    };
  }

  /** OpenAI 请求体：工具定义 + 消息块双向转换。 */
  private buildOpenAiTurnBody(tools: AgentTool[], messages: AgentMessage[]): Record<string, unknown> {
    return {
      model: this.cfg.model,
      max_tokens: TURN_MAX_TOKENS,
      tool_choice: 'auto',
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
      messages: messages.flatMap((m) => toOpenAiMessages(m)),
    };
  }

  /**
   * Anthropic 响应解析：真实 API 可能一次返回多个块（如 text+tool_use），
   * runner 只取一个块，这里按 stop_reason 归一化：tool_use 停 → 取工具块；
   * 否则取第一个文本块。形状不合法 → BAD_JSON。
   */
  private parseAnthropicResponse(raw: string): TurnResult {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    const stopReason = body['stop_reason'];
    const blocks = body['content'];
    if (typeof stopReason !== 'string' || !Array.isArray(blocks)) {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    const typed = blocks as AgentContentBlock[];
    const chosen = stopReason === 'tool_use'
      ? typed.find((b) => b.type === 'tool_use')
      : typed.find((b) => b.type === 'text') ?? typed[0];
    if (chosen === undefined) {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    return {
      kind: 'ok',
      response: {
        id: String(body['id'] ?? ''),
        model: String(body['model'] ?? this.cfg.model),
        stop_reason: stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
        content: [chosen],
      },
    };
  }

  /**
   * OpenAI 响应解析：choices[0].finish_reason=tool_calls → 取第一个函数调用
   * 转 tool_use 块（arguments 必须是合法 JSON，否则 BAD_JSON）；
   * 其余 → content 转文本块。
   */
  private parseOpenAiResponse(raw: string): TurnResult {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    const choice = (body['choices'] as unknown[])?.[0] as
      | { finish_reason?: string; message?: Record<string, unknown> }
      | undefined;
    if (choice?.message === undefined) {
      return { kind: 'protocol_error', code: 'BAD_JSON', raw };
    }
    const msg = choice.message;

    if (choice.finish_reason === 'tool_calls') {
      const call = (msg['tool_calls'] as unknown[])?.[0] as
        | { id?: string; function?: { name?: string; arguments?: string } }
        | undefined;
      if (call?.id === undefined || call.function?.name === undefined || call.function.arguments === undefined) {
        return { kind: 'protocol_error', code: 'BAD_JSON', raw };
      }
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        return { kind: 'protocol_error', code: 'BAD_JSON', raw };
      }
      const block: AgentContentBlock = {
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input,
      };
      return {
        kind: 'ok',
        response: {
          id: String(body['id'] ?? ''),
          model: String(body['model'] ?? this.cfg.model),
          stop_reason: 'tool_use',
          content: [block],
        },
      };
    }

    const text = typeof msg['content'] === 'string' ? msg['content'] : '';
    return {
      kind: 'ok',
      response: {
        id: String(body['id'] ?? ''),
        model: String(body['model'] ?? this.cfg.model),
        stop_reason: 'end_turn',
        content: [{ type: 'text', text }],
      },
    };
  }

  // -------------------------------------------------------------------------
  // callAudit：用真实模型 + 强约束 prompt 充当审计员
  // -------------------------------------------------------------------------

  async callAudit(text: string, _groupId: string): Promise<AuditResult> {
    try {
      const content = await this.requestAuditText(text);
      return parseAuditJson(content);
    } catch (err) {
      // 网络/超时等调用失败：按 audit error 处理（runner 累计 3 次 → audit_blocked）
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 按提供方发起一次审计补全，只取文本。 */
  private async requestAuditText(text: string): Promise<string> {
    if (this.cfg.provider === 'anthropic') {
      const res = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.authHeaders('anthropic'),
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: AUDIT_MAX_TOKENS,
          system: AUDIT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `待发送文本：${text}` }],
        }),
        signal: AbortSignal.timeout(LLM_TURN_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`audit HTTP ${res.status}`);
      const body = (await res.json()) as { content?: AgentContentBlock[] };
      return body.content?.find((b) => b.type === 'text')?.text ?? '';
    }

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders('openai'),
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: AUDIT_MAX_TOKENS,
        messages: [
          { role: 'system', content: AUDIT_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TURN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`audit HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? '';
  }

  /** 鉴权头：两家用不同的 key 传递方式。 */
  private authHeaders(provider: 'anthropic' | 'openai'): Record<string, string> {
    return provider === 'anthropic'
      ? {
          'content-type': 'application/json',
          'x-api-key': this.cfg.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        }
      : {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        };
  }
}

// ---------------------------------------------------------------------------
// 内部块协议 ↔ OpenAI Chat Completions 转换
// ---------------------------------------------------------------------------

/** OpenAI 消息（只列用到的字段，保持宽松）。 */
type OpenAiMessage = Record<string, unknown>;

/**
 * 把一条内部消息展开为 0..n 条 OpenAI 消息。
 * 一条内部 assistant 消息可能同时含文本与多个 tool_use；
 * OpenAI 要求文本与 tool_calls 同处一条 assistant 消息，这里合并。
 */
export function toOpenAiMessages(message: AgentMessage): OpenAiMessage[] {
  const blocks: AgentContentBlock[] = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;

  if (message.role === 'assistant') {
    const textParts: string[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    for (const b of blocks) {
      if (b.type === 'text') {
        textParts.push(b.text);
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        });
      }
      // assistant 侧不应出现 tool_result，防御性忽略
    }
    const out: OpenAiMessage = { role: 'assistant' };
    if (textParts.length > 0) out['content'] = textParts.join('\n');
    if (toolCalls.length > 0) {
      out['tool_calls'] = toolCalls;
      if (textParts.length === 0) out['content'] = null;
    }
    return Object.keys(out).length > 1 ? [out] : [];
  }

  // user：文本块合并为一条 user 消息；每个 tool_result 独立成一条 tool 消息，
  // 保持块出现顺序（OpenAI 用 tool_call_id 配对，连续 tool 消息合法）。
  const out: OpenAiMessage[] = [];
  let textBuf: string[] = [];
  const flushText = (): void => {
    if (textBuf.length > 0) {
      out.push({ role: 'user', content: textBuf.join('\n') });
      textBuf = [];
    }
  };
  for (const b of blocks) {
    if (b.type === 'text') {
      textBuf.push(b.text);
    } else if (b.type === 'tool_result') {
      flushText();
      out.push({
        role: 'tool',
        tool_call_id: b.tool_use_id,
        content: b.content,
      });
    }
    // user 侧出现 tool_use 不合协议，防御性忽略
  }
  flushText();
  return out;
}

/**
 * 解析审计模型返回的文本：容错提取第一个 JSON 对象（允许 ```json 包裹），
 * verdict=pass → pass；verdict=fail → fail（带 reason）；其余 → error。
 */
export function parseAuditJson(text: string): AuditResult {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m === null) return { kind: 'error', message: 'audit: 模型未返回 JSON' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return { kind: 'error', message: 'audit: 返回的 JSON 不可解析' };
  }
  if (parsed['verdict'] === 'pass') return { kind: 'pass' };
  if (parsed['verdict'] === 'fail') {
    const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '审计未通过';
    return { kind: 'fail', reason };
  }
  return { kind: 'error', message: `audit: 无法识别的 verdict：${String(parsed['verdict'])}` };
}

/** 错误响应只保留前 2KB，与 runner 的 rawResponse 上限一致，避免日志膨胀。 */
function truncateRaw(raw: string): string {
  return raw.length > 2048 ? `${raw.slice(0, 2048)}…(truncated)` : raw;
}

// ---------------------------------------------------------------------------
// 工厂：按 AGENT_PROVIDER 选择 mock HTTP 客户端或真实 LLM 客户端
// ---------------------------------------------------------------------------

/** 工厂所需的最小配置视图（直接传 AppConfig 即可）。 */
export interface AgentClientFactoryConfig {
  readonly agentProvider: 'mock' | 'anthropic' | 'openai';
  readonly agentUrl: string;
  readonly agentBaseUrl: string;
  readonly agentApiKey: string | null;
  readonly agentModel: string;
}

/**
 * 构造 agent 客户端。
 *   provider=mock     → AgentClient（调 agent-mock /agent/* 端点，离线可用）
 *   provider=其它     → RealLlmAgentClient（env 已保证 apiKey 非空）
 * 返回结构相同（callTurn/callAudit），runner 与 worker 无需感知差异。
 */
export function createAgentClient(
  config: AgentClientFactoryConfig,
  log: LoggerLike,
): AgentClient | RealLlmAgentClient {
  if (config.agentProvider === 'mock') {
    return new AgentClient(config.agentUrl, log);
  }
  return new RealLlmAgentClient(
    {
      provider: config.agentProvider,
      baseUrl: config.agentBaseUrl,
      // loadConfig 已对"非 mock 必须有 key"做启动校验
      apiKey: config.agentApiKey as string,
      model: config.agentModel,
    },
    log,
  );
}
