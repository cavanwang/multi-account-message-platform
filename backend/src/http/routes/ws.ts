/**
 * WebSocket 路由（规划 04 §4，任务 4.12）。
 *
 * 端点：GET /ws（升级为 WebSocket）
 *
 * 握手协议：
 *   客户端连接后必须先发一帧 JSON：
 *     { "type": "auth", "accessToken": "...", "sinceSeq": 0 }
 *   - sinceSeq 可选：断线重连时传上次收到的最大 seq，后端补发 (sinceSeq, ∞)
 *   - token 无效 → 回 { type: "auth", success: false } 并关闭连接
 *   - token 有效 → 回 { type: "auth", success: true }，然后：
 *       1. 先登记到 WsHub（订阅实时推送）
 *       2. 再补发 seq ∈ (sinceSeq, currentMaxSeq] 的事件
 *       3. 此后实时事件由 WsPublisher → WsHub 推送
 *
 * 防漏设计：先登记再补发。补发期间到达的新事件会被 hub 推送到本连接，
 * 客户端按 seq 去重即可（规划 04 §4.2 INV-10）。
 *
 * 推送帧格式：{ seq, type, payload }
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyAccessToken } from '../../auth/tokens.js';
import type { AppConfig } from '../../config/env.js';
import type { Pool } from 'pg';
import { fetchEventsAfter } from '../../repos/web-events.js';
import type { WsHub } from '../../services/ws-hub.js';

interface WsRouteDeps {
  config: AppConfig;
  pool: Pool;
  hub: WsHub;
}

/** 客户端发来的 auth 帧。 */
interface AuthFrame {
  type?: unknown;
  accessToken?: unknown;
  sinceSeq?: unknown;
}

/** 注册 WebSocket 路由（需先在 server.ts 中 register @fastify/websocket）。 */
export function registerWsRoutes(app: FastifyInstance, deps: WsRouteDeps): void {
  const { config, pool, hub } = deps;

  // @fastify/websocket 通过 { websocket: true } 标记 WS 路由
  // 运行时 handler 签名为 (socket, request)，socket 直接是 WebSocket 实例
  app.get<{ Querystring: Record<string, string> }>(
    '/ws',
    { websocket: true },
    (socket: WebSocket, _req: FastifyRequest) => {
      let authed = false;

      // 只处理第一帧（auth）；auth 成功后消息由 hub 推送，不再监听 message
      socket.once('message', async (data: Buffer) => {
        let frame: AuthFrame;
        try {
          frame = JSON.parse(data.toString('utf8')) as AuthFrame;
        } catch {
          sendAuthFailure(socket, 'auth frame 不是合法 JSON');
          return;
        }

        if (frame?.type !== 'auth') {
          sendAuthFailure(socket, '首帧必须是 { type: "auth" }');
          return;
        }

        const token = typeof frame.accessToken === 'string' ? frame.accessToken : '';
        if (token === '') {
          sendAuthFailure(socket, 'accessToken 缺失');
          return;
        }

        // 验证 token
        try {
          await verifyAccessToken(config, token);
        } catch {
          sendAuthFailure(socket, 'accessToken 无效或已过期');
          return;
        }

        authed = true;
        // 先发 auth 成功
        socket.send(JSON.stringify({ type: 'auth', success: true }));

        // 1. 先登记到 hub（订阅实时），避免补发期间的新事件丢失
        hub.add(socket);

        // 2. 补发 sinceSeq 之后的事件（循环取完，避免超过单批上限时丢事件）
        const sinceSeq = typeof frame.sinceSeq === 'number' && Number.isFinite(frame.sinceSeq)
          ? Math.max(0, Math.floor(frame.sinceSeq))
          : 0;
        try {
          let cursorSeq = sinceSeq;
          // 每批最多 500 条；若取满则继续从最大 seq 往后取，直到不足一批
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (socket.readyState !== socket.OPEN) break;
            const events = await fetchEventsAfter(pool, cursorSeq, 500);
            for (const evt of events) {
              if (socket.readyState !== socket.OPEN) break;
              socket.send(JSON.stringify({ seq: evt.seq, type: evt.type, payload: evt.payload }));
            }
            if (events.length < 500) break;
            cursorSeq = events[events.length - 1]!.seq;
          }
        } catch (err) {
          // 补发失败不关闭连接：实时推送仍可工作，客户端下次重连再补
          console.error('[WS] 补发事件失败:', err);
        }
      });

      // 连接关闭时若已认证则从 hub 移除（hub 内部也监听 close，此处为双保险）
      socket.once('close', () => {
        if (authed) hub.remove(socket);
      });
    },
  );
}

/** 发送 auth 失败帧并关闭连接。 */
function sendAuthFailure(socket: WebSocket, reason: string): void {
  socket.send(JSON.stringify({ type: 'auth', success: false, reason }));
  socket.close();
}
