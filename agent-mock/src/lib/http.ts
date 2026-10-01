/**
 * 极简 HTTP 辅助（参照 gateway-mock/src/lib/http.ts）。
 *
 * agent-mock 只用原生 http，不引入框架，保持轻量。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 读取请求体并解析 JSON，失败返回 null。 */
export async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** 发送 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** 发送原始字符串响应（用于坏行为模式，如 markdown 围栏）。 */
export function sendRaw(res: ServerResponse, status: number, body: string, contentType = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 发送错误响应。 */
export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}
