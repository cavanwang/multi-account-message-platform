/**
 * WebSocket 推送 worker（规划 04 §4，任务 4.13）。
 *
 * 职责：
 *   - 轮询 web_events 表，取 seq > last_pushed_seq 的事件；
 *   - 通过 WsHub 广播给所有已连接的前端；
 *   - 更新 ws_push_cursor.last_pushed_seq = 本轮最大 seq。
 *
 * 设计要点：
 *   - **游标始终前进**：即使当前无客户端连接，也推进游标。客户端断线重连时
 *     用 sinceSeq 从 DB 直接补发（不走游标），不会丢事件；
 *   - **批量推送**：每轮最多取 batchSize 条，推完再更新游标；
 *   - **崩溃安全**：游标持久化在 ws_push_cursor 表，重启后从上次位置继续；
 *   - **幂等**：客户端按 seq 去重，重复推送无害。
 */
import type { Pool } from 'pg';
import { fetchEventsAfter, updatePushCursor, getPushCursor } from '../repos/web-events.js';
import type { WsHub } from '../services/ws-hub.js';

export interface WsPublisherOptions {
  /** 轮询间隔（毫秒），默认 500。 */
  intervalMs?: number;
  /** 每轮批量取事件数，默认 100。 */
  batchSize?: number;
}

export class WsPublisher {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPushedSeq = 0;

  constructor(
    private readonly pool: Pool,
    private readonly hub: WsHub,
    private readonly options: WsPublisherOptions = {},
  ) {}

  /** 启动：先加载游标，再开始轮询。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastPushedSeq = await getPushCursor(this.pool);
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const intervalMs = this.options.intervalMs ?? 500;
    this.timer = setTimeout(() => void this.tick(), intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      const batchSize = this.options.batchSize ?? 100;
      const events = await fetchEventsAfter(this.pool, this.lastPushedSeq, batchSize);
      if (events.length > 0) {
        let maxSeq = this.lastPushedSeq;
        for (const evt of events) {
          this.hub.broadcast({
            seq: evt.seq,
            type: evt.type,
            payload: evt.payload,
          });
          if (evt.seq > maxSeq) maxSeq = evt.seq;
        }
        // 只在确实推进时更新，避免无谓写
        if (maxSeq > this.lastPushedSeq) {
          this.lastPushedSeq = maxSeq;
          await updatePushCursor(this.pool, maxSeq);
        }
      }
    } catch (err) {
      // 轮询失败不中断 worker：下一轮重试，事件不会丢（游标未推进）
      console.error('[WsPublisher] tick 失败:', err);
    } finally {
      this.scheduleNext();
    }
  }
}
