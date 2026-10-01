/**
 * 真实 LLM 客户端测试（C2 选做，5.26）。
 *
 * 不出网、不依赖真实 key：用 vi 替换全局 fetch，验证：
 *  - Anthropic：请求 URL/头/体直通；多块响应归一化；401→BAD_JSON；超时→TURN_TIMEOUT
 *  - OpenAI：工具/消息双向转换（tool_calls / role:tool）；响应转回内部块；坏 arguments→BAD_JSON
 *  - callAudit：两提供方请求形态与 JSON 结果解析；网络异常→error
 *  - parseAuditJson：pass/fail/非 JSON/代码围栏容错
 *  - createAgentClient：mock → AgentClient；anthropic/openai → RealLlmAgentClient
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientLike } from '../../src/services/agent-runner.js';
import {
  RealLlmAgentClient,
  createAgentClient,
  parseAuditJson,
} from '../../src/services/llm-clients.js';
import { AgentClient } from '../../src/services/agent-client.js';
import type { LoggerLike } from '../../src/services/gateway-client.js';

const silentLog: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ANTHROPIC_CFG = {
  provider: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'test-key',
  model: 'claude-test',
};
const OPENAI_CFG = {
  provider: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
};

/** fetch mock 调用参数（url + init）。 */
interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** JSON 200 响应。 */
function jsonResponse(obj: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(obj), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

const TOOLS = [
  {
    name: 'send_message',
    description: '发消息',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RealLlmAgentClient — Anthropic', () => {
  it('请求直通 Messages API：URL/鉴权头/体（tools 与 messages 不转换）', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 'm1',
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RealLlmAgentClient(ANTHROPIC_CFG, silentLog);
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
    const result = await client.callTurn('run-1', TOOLS, messages);

    expect(result.kind).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, FetchInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers?.['x-api-key']).toBe('test-key');
    expect(init.headers?.['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body ?? '{}');
    expect(body.model).toBe('claude-test');
    expect(body.max_tokens).toBe(1024);
    // Anthropic 协议同源：tools 保留 input_schema，不做 function 包裹
    expect(body.tools[0]).toMatchObject({ name: 'send_message', input_schema: TOOLS[0]!.input_schema });
    expect(body.messages).toEqual(messages);
  });

  it('多块响应（text+tool_use, stop=tool_use）→ 归一化取 tool_use 块', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        id: 'm2',
        model: 'claude-test',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'let me' },
          { type: 'tool_use', id: 'tu1', name: 'send_message', input: { text: 'hi' } },
        ],
      }),
    ));
    const result = await new RealLlmAgentClient(ANTHROPIC_CFG, silentLog)
      .callTurn('r', TOOLS, [{ role: 'user', content: 'hi' }]);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.response.stop_reason).toBe('tool_use');
    expect(result.response.content).toHaveLength(1);
    expect(result.response.content[0]).toMatchObject({ type: 'tool_use', id: 'tu1' });
  });

  it('上游 401 → protocol_error/BAD_JSON，响应体原样保留', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ type: 'error', error: { message: 'bad key' } }, { status: 401 }),
    ));
    const result = await new RealLlmAgentClient(ANTHROPIC_CFG, silentLog)
      .callTurn('r', TOOLS, [{ role: 'user', content: 'hi' }]);
    expect(result).toMatchObject({ kind: 'protocol_error', code: 'BAD_JSON' });
  });

  it('超时（TimeoutError）→ protocol_error/TURN_TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }));
    const result = await new RealLlmAgentClient(ANTHROPIC_CFG, silentLog)
      .callTurn('r', TOOLS, [{ role: 'user', content: 'hi' }]);
    expect(result).toMatchObject({ kind: 'protocol_error', code: 'TURN_TIMEOUT' });
  });
});

describe('RealLlmAgentClient — OpenAI', () => {
  it('请求转换：tools 包 function；assistant tool_use → tool_calls；user tool_result → role:tool', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 'c1',
        model: 'gpt-test',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RealLlmAgentClient(OPENAI_CFG, silentLog);
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'go' },
          { type: 'tool_result' as const, tool_use_id: 'tu0', content: 'prev result' },
        ],
      },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'thinking' },
          { type: 'tool_use' as const, id: 'tu1', name: 'send_message', input: { text: 'hi' } },
        ],
      },
    ];
    const result = await client.callTurn('r', TOOLS, messages);
    expect(result.kind).toBe('ok');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, FetchInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers?.['authorization']).toBe('Bearer test-key');
    const body = JSON.parse(init.body ?? '{}');
    expect(body.tool_choice).toBe('auto');
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 'send_message', description: '发消息', parameters: TOOLS[0]!.input_schema },
    });
    // user：文本一条 + tool 结果一条（tool_call_id 配对）
    expect(body.messages[0]).toEqual({ role: 'user', content: 'go' });
    expect(body.messages[1]).toEqual({ role: 'tool', tool_call_id: 'tu0', content: 'prev result' });
    // assistant：文本与 tool_calls 合并在同一条（OpenAI 要求）
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: 'thinking',
      tool_calls: [{
        id: 'tu1',
        type: 'function',
        function: { name: 'send_message', arguments: JSON.stringify({ text: 'hi' }) },
      }],
    });
  });

  it('响应 tool_calls → 内部 tool_use 块（arguments JSON 解析）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        id: 'c2',
        model: 'gpt-test',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc1',
              type: 'function',
              function: { name: 'send_message', arguments: JSON.stringify({ text: 'hello' }) },
            }],
          },
        }],
      }),
    ));
    const result = await new RealLlmAgentClient(OPENAI_CFG, silentLog)
      .callTurn('r', TOOLS, [{ role: 'user', content: 'hi' }]);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.response.stop_reason).toBe('tool_use');
    expect(result.response.content[0]).toEqual({
      type: 'tool_use', id: 'tc1', name: 'send_message', input: { text: 'hello' },
    });
  });

  it('响应 stop + content → 文本块', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        id: 'c3',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'bye' } }],
      }),
    ));
    const result = await new RealLlmAgentClient(OPENAI_CFG, silentLog)
      .callTurn('r', TOOLS, [{ role: 'user', content: 'hi' }]);
    if (result.kind !== 'ok') throw new Error('should be ok');
    expect(result.response.content).toEqual([{ type: 'text', text: 'bye' }]);
  });

  it('arguments 非法 JSON → BAD_JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: 'not-json' } }],
          },
        }],
      }),
    ));
    const result = await new RealLlmAgentClient(OPENAI_CFG, silentLog)
      .callTurn('r', TOOLS, [{ role: 'user', content: 'hi' }]);
    expect(result).toMatchObject({ kind: 'protocol_error', code: 'BAD_JSON' });
  });
});

describe('RealLlmAgentClient — callAudit（真实模型审计）', () => {
  it('Anthropic：/v1/messages + system 约束，返回 pass JSON → pass', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: '{"verdict":"pass"}' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RealLlmAgentClient(ANTHROPIC_CFG, silentLog).callAudit('hello', 'g1');
    expect(result).toEqual({ kind: 'pass' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, FetchInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body ?? '{}');
    expect(body.system).toContain('审计');
    expect(body.max_tokens).toBe(200);
  });

  it('OpenAI：/chat/completions，fail JSON（带代码围栏）→ fail + reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '```json\n{"verdict":"fail","reason":"含骚扰内容"}\n```' } }],
      }),
    ));
    const result = await new RealLlmAgentClient(OPENAI_CFG, silentLog).callAudit('bad', 'g1');
    expect(result).toEqual({ kind: 'fail', reason: '含骚扰内容' });
  });

  it('网络异常 → error（由 runner 计入 audit_blocked 累计）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNRESET');
    }));
    const result = await new RealLlmAgentClient(OPENAI_CFG, silentLog).callAudit('x', 'g1');
    expect(result.kind).toBe('error');
  });
});

describe('parseAuditJson', () => {
  it('pass / fail+reason / 无 JSON / 坏 verdict 各自归类', () => {
    expect(parseAuditJson('{"verdict":"pass"}')).toEqual({ kind: 'pass' });
    expect(parseAuditJson('前缀 {"verdict":"fail","reason":"r"} 后缀')).toEqual({ kind: 'fail', reason: 'r' });
    expect(parseAuditJson('no json here').kind).toBe('error');
    expect(parseAuditJson('{"verdict":"maybe"}').kind).toBe('error');
  });
});

describe('createAgentClient 工厂', () => {
  it('provider=mock → AgentClient（agent-mock 端点）', () => {
    const client = createAgentClient(
      {
        agentProvider: 'mock',
        agentUrl: 'http://agent-mock:3200',
        agentBaseUrl: '',
        agentApiKey: null,
        agentModel: '',
      },
      silentLog,
    );
    expect(client).toBeInstanceOf(AgentClient);
  });

  it('provider=anthropic/openai → RealLlmAgentClient，且结构满足 AgentClientLike', () => {
    for (const [provider, baseUrl] of [
      ['anthropic', 'https://api.anthropic.com'],
      ['openai', 'https://api.openai.com/v1'],
    ] as const) {
      const client = createAgentClient(
        {
          agentProvider: provider,
          agentUrl: '',
          agentBaseUrl: baseUrl,
          agentApiKey: 'k',
          agentModel: 'm',
        },
        silentLog,
      );
      expect(client).toBeInstanceOf(RealLlmAgentClient);
      expect(typeof (client as AgentClientLike).callTurn).toBe('function');
      expect(typeof (client as AgentClientLike).callAudit).toBe('function');
    }
  });
});
