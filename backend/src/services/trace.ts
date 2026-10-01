/**
 * 全链路 traceId 上下文（基于 Node AsyncLocalStorage）。
 *
 * 设计目标：业务代码零侵入地获得 traceId 追踪能力。
 *   - **日志侧**：pino 配置 `mixin: pinoMixin` 后，每条日志自动带 `traceId` 字段；
 *   - **出站 HTTP 侧**：进程启动时调用一次 {@link installFetchTracing}，
 *     上下文内的所有 fetch 自动注入 `x-request-id` 请求头；
 *   - **入口侧**：HTTP 请求在 onRequest 钩子里 {@link enterTrace}（沿用 Fastify reqId）；
 *     worker 每个处理单元用 {@link withNewTrace} / {@link enterTrace} 开启。
 *
 * 为什么用 AsyncLocalStorage：它随 async/await 隐式传播，service / repo 等
 * 深层代码无需把 traceId 一路透传，也不污染任何业务函数签名。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** 单个追踪上下文。 */
export interface TraceContext {
  readonly traceId: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * 在**指定 traceId** 的上下文中同步执行 fn（上下文随其返回的 Promise 延续）。
 * 用于已有 traceId 需要沿用的场景。
 */
export function withTrace<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn);
}

/**
 * 在**新生成 traceId** 的上下文中执行 fn，并把 traceId 传给 fn。
 * fn 可以是 async：返回 Promise 时上下文在 await 链路上继续有效。
 */
export function withNewTrace<T>(fn: (traceId: string) => T): T {
  const traceId = randomUUID();
  return storage.run({ traceId }, () => fn(traceId));
}

/**
 * 把当前执行链切换到指定 traceId 的上下文。
 *
 * 仅用于**无法用 storage.run 包裹整个生命周期**的场景——典型是 Fastify 请求：
 * onRequest 钩子返回后，路由处理仍在同一异步延续链上执行，enterWith 能让
 * 钩子之后的整条请求链路（handler、错误处理、响应日志）都处于该上下文中。
 * 普通 worker 循环优先使用 {@link withNewTrace}（边界更清晰）。
 */
export function enterTrace(traceId: string): void {
  storage.enterWith({ traceId });
}

/** 退出当前上下文（后续日志不再带 traceId）。用于 enterTrace 之后收尾。 */
export function exitTrace(): void {
  storage.disable();
}

/** 读取当前链路的 traceId；不在任何追踪上下文中时返回 undefined。 */
export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * pino `mixin`：每条日志输出时被调用，把当前 traceId 合并进日志对象。
 * 无上下文时返回空对象，不增加任何字段。
 */
export function pinoMixin(): Record<string, unknown> {
  const traceId = getTraceId();
  return traceId === undefined ? {} : { traceId };
}

// ---------------------------------------------------------------------------
// fetch 仪表化：自动透传 x-request-id
// ---------------------------------------------------------------------------

/** 透传所用的请求头 / 响应头名称（全小写，HTTP/2 头部不区分大小写）。 */
export const TRACE_HEADER = 'x-request-id';

let fetchTracingInstalled = false;

/**
 * 包装全局 fetch：在 trace 上下文内发起的请求自动加 `x-request-id` 头，
 * 使外部服务（消息网关 / Agent）可按同一 ID 关联日志。
 *
 * - 幂等：重复调用只安装一次；
 * - 上下文外的请求保持原行为，对单测与未追踪逻辑零影响；
 * - 已显式携带该头的请求也被覆盖为当前 traceId（保证链路口径一致）。
 */
export function installFetchTracing(): void {
  if (fetchTracingInstalled) return;
  fetchTracingInstalled = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (...args: Parameters<typeof fetch>): Promise<Response> => {
    const traceId = getTraceId();
    if (traceId === undefined) {
      return originalFetch(...args);
    }
    const [input, init] = args;
    return originalFetch(input, injectTraceHeader(input, init, traceId));
  };
}

/**
 * 构造带 trace 头的 RequestInit。
 * 合并顺序（后者覆盖前者）：Request 对象原有头 → init.headers → trace 头。
 * 这样无论调用方用 Request 还是裸 URL + headers，原有头都不会丢失。
 */
function injectTraceHeader(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  traceId: string,
): RequestInit {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init !== undefined && init.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  headers.set(TRACE_HEADER, traceId);
  return { ...init, headers };
}
