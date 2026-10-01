/**
 * WebSocket 连接中心（规划 04 §4，任务 4.12）。
 *
 * 职责：
 *   - 维护所有已通过 auth 握手的连接集合；
 *   - 向全部存活连接广播前端事件（ws-publisher worker 调用）。
 *
 * 设计要点：
 *   - 连接关闭时自动从集合移除（监听 'close' 事件），避免内存泄漏；
 *   - broadcast 只向 OPEN 状态的 socket 发送，跳过正在关闭的连接；
 *   - 单个连接的发送异常不应影响其他连接（try/catch 隔离）。
 */
import type { WebSocket } from 'ws';

/** 推送给前端的事件帧。 */
export interface WsEventFrame {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

export class WsHub {
  private readonly clients = new Set<WebSocket>();

  /** 登记一个已认证的连接。 */
  add(socket: WebSocket): void {
    this.clients.add(socket);
    // 关闭时自动移除，无需调用方手动清理
    socket.once('close', () => {
      this.clients.delete(socket);
    });
  }

  /** 手动移除（auth 失败等场景）。 */
  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  /** 向所有存活连接广播一帧事件。 */
  broadcast(frame: WsEventFrame): void {
    const msg = JSON.stringify(frame);
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        try {
          socket.send(msg);
        } catch {
          // 单个连接发送失败不影响其他连接
        }
      }
    }
  }

  /** 当前连接数（调试/监控用）。 */
  get size(): number {
    return this.clients.size;
  }
}
