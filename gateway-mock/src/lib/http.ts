/**
 * HTTP 工具：统一错误响应、JSON 读取、SSE 连接管理。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { onDisconnectRequest } from './event-bus.js';
import type { GatewayEvent } from '../types.js';

/** 网关错误响应形状：{ error: { code, ... } }。 */
export function sendError(res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}): void {
  const payload = { error: { code, ...extra } };
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body ?? {}));
}

/** 读取并解析 JSON 请求体；空体返回 {}；非法 JSON 抛 400。 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const err = new Error('请求体不是合法 JSON') as Error & { status: number; code: string };
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// SSE 连接
// ---------------------------------------------------------------------------

interface SSEConnection {
  close(): void;
}

/** 当前活跃的 SSE 连接。 */
const connections = new Set<SSEConnection>();

/** 注册"要求断开全部连接"的处理器（由 event-bus 广播触发）。 */
export function installDisconnectHandler(): void {
  onDisconnectRequest(() => {
    for (const conn of [...connections]) conn.close();
  });
}

/** 事件总线的接口（用于类型解耦）。 */
interface EventBus {
  replaySince(since: number): GatewayEvent[];
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

/**
 * 建立一个 SSE 连接。
 *
 * - 立即按 `since` 补发历史事件（since 为**独占**语义：返回 eventId > since）；
 * - 不带 since 表示"从当前时刻开始"，即只推此后产生的新事件；
 * - 之后持续推送新事件，并周期性发送心跳注释，避免中间层因空闲而断开连接。
 */
export function openEventStream(res: ServerResponse, bus: EventBus, since: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // 禁用 nginx 之类的缓冲
  });
  // 首帧注释，让客户端确认连接已建立
  res.write(': connected\n\n');

  const write = (event: GatewayEvent): void => {
    res.write(`id: ${event.eventId}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 1) 补发历史（if since 有值）
  if (typeof since === 'number' && Number.isFinite(since)) {
    for (const event of bus.replaySince(since)) write(event);
  }

  // 2) 订阅后续事件
  const unsubscribe = bus.subscribe(write);

  // 3) 心跳
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  const conn: SSEConnection = {
    close() {
      clearInterval(heartbeat);
      unsubscribe();
      connections.delete(conn);
      try {
        res.end();
      } catch {
        // 连接可能已被对端关闭
      }
    },
  };
  connections.add(conn);

  res.on('close', () => conn.close());
}

export function activeConnectionCount(): number {
  return connections.size;
}
