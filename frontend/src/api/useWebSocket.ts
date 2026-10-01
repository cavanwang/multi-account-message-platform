/**
 * WebSocket 连接 Hook（A4 实时推送）。
 *
 * 协议（见后端 ws.ts）：
 *   1. 连接 /ws 后先发 { type: 'auth', accessToken, sinceSeq }
 *   2. 服务端回 { type: 'auth', success: true } 后开始推 { seq, type, payload }
 *   3. seq 全局单调递增；重连时带 sinceSeq = 已收到的最大 seq，服务端补发缺口
 *
 * 行为：
 *   - 断线自动重连（1s 起步、指数退避、上限 10s）
 *   - auth 失败（token 过期）→ 先 refresh 换新 token 再重连
 *   - 同一 seq 重复到达（补发与实时交叠）由内部去重，回调只收到一次
 */
import { useEffect, useRef, useState } from 'react';
import { getAccessToken, restoreSession } from './client';
import type { WsEventFrame } from './types';

export type WsStatus = 'connecting' | 'open' | 'closed';

interface UseWebSocketOptions {
  /** 收到事件帧（已按 seq 去重）。 */
  onEvent: (frame: WsEventFrame) => void;
  /** 是否启用（未登录时传 false）。 */
  enabled: boolean;
}

export function useWebSocket({ onEvent, enabled }: UseWebSocketOptions): WsStatus {
  const [status, setStatus] = useState<WsStatus>('closed');
  // 已处理的最大 seq：-1 表示尚未收到任何事件
  const maxSeqRef = useRef(-1);
  // 回调用 ref 持有，避免因组件重渲染而重建连接
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    let ws: WebSocket | null = null;
    let closedByEffect = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const connect = (): void => {
      const token = getAccessToken();
      if (token === null) return; // 未登录不连

      setStatus('connecting');
      // 同源连接：开发走 Vite proxy，生产走 nginx 反代
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);

      ws.onopen = () => {
        // 认证帧携带 sinceSeq：断线期间的事件由服务端补发
        ws?.send(
          JSON.stringify({
            type: 'auth',
            accessToken: token,
            sinceSeq: Math.max(0, maxSeqRef.current),
          }),
        );
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return; // 非 JSON 帧忽略
        }

        // auth 响应帧
        if (frame['type'] === 'auth') {
          if (frame['success'] === true) {
            attempts = 0;
            setStatus('open');
          } else {
            // token 失效：关闭后由 onclose 触发重连流程（会先 refresh）
            ws?.close();
          }
          return;
        }

        // 事件帧：按 seq 去重（补发与实时推送可能交叠）
        const seq = frame['seq'];
        if (typeof seq !== 'number') return;
        if (seq <= maxSeqRef.current) return;
        maxSeqRef.current = seq;
        onEventRef.current({
          seq,
          type: String(frame['type'] ?? ''),
          payload: (frame['payload'] ?? {}) as Record<string, unknown>,
        });
      };

      ws.onclose = () => {
        setStatus('closed');
        if (closedByEffect) return;
        // 指数退避重连：1s, 2s, 4s … 上限 10s
        attempts += 1;
        const delay = Math.min(1000 * 2 ** (attempts - 1), 10_000);
        retryTimer = setTimeout(() => {
          void reconnect();
        }, delay);
      };

      ws.onerror = () => {
        // 错误后会紧跟 close，统一在 onclose 处理
        ws?.close();
      };
    };

    /** auth 失败场景的重连：先尝试刷新 token，成功再连。 */
    const reconnect = async (): Promise<void> => {
      if (closedByEffect) return;
      // token 可能已过期：先静默 refresh（single-flight，与 HTTP 401 共用同一次请求）
      await restoreSession();
      if (closedByEffect) return;
      connect();
    };

    connect();

    return () => {
      closedByEffect = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      ws?.close();
      setStatus('closed');
    };
  }, [enabled]);

  return status;
}
