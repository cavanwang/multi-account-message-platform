/**
 * trace 上下文单测（services/trace.ts）。
 *
 * 纯逻辑测试，不依赖数据库；通过 stub 全局 fetch 验证出站头注入。
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
  withTrace,
  withNewTrace,
  enterTrace,
  exitTrace,
  getTraceId,
  pinoMixin,
  installFetchTracing,
} from '../../src/services/trace.js';

describe('trace 上下文', () => {
  test('上下文外 getTraceId 为 undefined，pinoMixin 为空对象', () => {
    expect(getTraceId()).toBeUndefined();
    expect(pinoMixin()).toEqual({});
  });

  test('withTrace 在回调内设置指定 traceId，回调外恢复', () => {
    const inner = withTrace('fixed-id', () => getTraceId());
    expect(inner).toBe('fixed-id');
    expect(getTraceId()).toBeUndefined();
  });

  test('withNewTrace 生成 UUID 并传给回调', () => {
    let seen = '';
    const result = withNewTrace((traceId) => {
      seen = traceId;
      return getTraceId();
    });
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toBe(seen);
    expect(getTraceId()).toBeUndefined();
  });

  test('上下文随 await 隐式传播', async () => {
    const result = await withNewTrace(async (traceId) => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return getTraceId() === traceId;
    });
    expect(result).toBe(true);
  });

  test('pinoMixin 在上下文内返回当前 traceId', () => {
    withTrace('mixin-id', () => {
      expect(pinoMixin()).toEqual({ traceId: 'mixin-id' });
    });
  });
});

describe('fetch 仪表化', () => {
  const stub = vi.fn();

  // 安装只做一次（installFetchTracing 幂等）：wrapped fetch 捕获的是 stub
  // 的稳定函数身份；beforeEach 只 reset 调用记录，不替换函数本身。
  beforeAll(() => {
    globalThis.fetch = stub as unknown as typeof fetch;
    installFetchTracing();
  });

  beforeEach(() => {
    stub.mockReset();
    // 任何入参都返回成功响应
    stub.mockResolvedValue(new Response('ok', { status: 200 }));
  });

  test('上下文外的请求不注入 x-request-id', async () => {
    await fetch('http://example.test/outside');
    const init = stub.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-request-id')).toBeNull();
  });

  test('上下文内的请求自动注入当前 traceId', async () => {
    let traceId = '';
    await withNewTrace(async (tid) => {
      traceId = tid;
      await fetch('http://example.test/inside', { method: 'POST' });
    });
    const init = stub.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('x-request-id')).toBe(traceId);
  });

  test('保留 Request 对象上的原有头', async () => {
    await withTrace('trace-req', async () => {
      const request = new Request('http://example.test/req', {
        headers: { 'x-custom': 'abc' },
      });
      await fetch(request);
    });
    const init = stub.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('x-custom')).toBe('abc');
    expect(headers.get('x-request-id')).toBe('trace-req');
  });

  test('保留 init.headers 中的原有头', async () => {
    await withTrace('trace-init', async () => {
      await fetch('http://example.test/init', { headers: { 'x-foo': 'bar' } });
    });
    const init = stub.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('x-foo')).toBe('bar');
    expect(headers.get('x-request-id')).toBe('trace-init');
  });
});

// 放在最后：enterWith 会改变后续延续链的上下文，必须在本测试内 exit 收尾，
// 避免泄漏到其它测试（此文件内该用例刻意排在末尾）。
describe('enterTrace / exitTrace', () => {
  test('切换并退出上下文（含 await 后仍然生效）', async () => {
    try {
      enterTrace('entered-id');
      expect(getTraceId()).toBe('entered-id');
      await Promise.resolve();
      expect(getTraceId()).toBe('entered-id');
    } finally {
      exitTrace();
    }
    expect(getTraceId()).toBeUndefined();
  });
});
