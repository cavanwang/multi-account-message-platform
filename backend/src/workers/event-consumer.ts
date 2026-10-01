/**
 * 事件消费 worker（规划 03 任务 3.8–3.10，INV-4 / INV-5）。
 *
 * 两条独立循环，互不阻塞：
 *
 *  1. **SSE ingest loop**（ingestLoop）：
 *     - fetch `${gatewayUrl}/events?since=${cursor}`，ReadableStream 逐帧读取；
 *     - 每帧一个事务：INSERT events_inbox ON CONFLICT DO NOTHING + UPDATE events_cursor；
 *     - 断流/报错 → 退避重连；since 独占语义保证停机期间的事件被补拉。
 *
 *  2. **消费 loop**（consumeBatch / runOnce）：
 *     - 轮询 events_inbox WHERE processed_at IS NULL ORDER BY event_id LIMIT ?；
 *     - 每条在独立事务内 dispatch 到 handler；
 *     - 成功 → processed_at=now()；
 *     - 失败 → attempts+1 + last_error + 入队 inconsistency web_event（不中断，继续下一条）。
 *
 * 设计要点：
 *  - at-least-once + (groupId,msgId) 去重：靠 events_inbox PK 与 messages upsert 共同保证；
 *  - ≤1s 乱序容忍：handler 内部 upsert 不依赖 sentAt 单调；
 *  - 自身消息回流：message 事件 handler 判定 isOwn，不触发 agent（切片 5）；
 *  - 崩溃安全：SSE 帧先落库再处理，崩溃后未处理的行下轮重试。
 *
 * 测试：`runOnce()` 消费一批待处理事件（不启动 SSE），便于用假数据驱动。
 */
import type { Pool, PoolClient } from 'pg';
import { EventsInboxRepo, type InboxRow } from '../repos/events-inbox.js';
import { enqueueWebEvent } from '../repos/web-events.js';
import type { LoggerLike } from '../services/gateway-client.js';
import { dispatch } from '../services/event-handlers/index.js';
import type { HandlerContext, MediaConfig } from '../services/event-handlers/types.js';
import { withNewTrace } from '../services/trace.js';

/** C1 媒体默认配置（测试未显式传入时使用）。 */
const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  mediaDir: '/tmp/mamp-media-test',
  mediaRetentionDays: 30,
  mediaCleanIntervalSeconds: 3600,
  gatewayUrl: 'http://unused',
};

export interface EventConsumerOptions {
  /** SSE 重连退避基数（毫秒），默认 500。 */
  reconnectBaseMs?: number;
  /** 最大重连间隔（毫秒），默认 5000。 */
  reconnectMaxMs?: number;
  /** 消费批大小，默认 50。 */
  batchSize?: number;
  /** 消费轮询间隔（毫秒），默认 200。 */
  intervalMs?: number;
}

export class EventConsumer {
  private readonly inboxRepo: EventsInboxRepo;
  private readonly opts: Required<EventConsumerOptions>;
  private readonly log: LoggerLike;
  private running = false;
  private sseAbort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly gatewayUrl: string,
    log: LoggerLike,
    options: EventConsumerOptions = {},
    private readonly mediaConfig: MediaConfig = DEFAULT_MEDIA_CONFIG,
  ) {
    this.inboxRepo = new EventsInboxRepo(pool);
    this.log = log;
    this.opts = {
      reconnectBaseMs: options.reconnectBaseMs ?? 500,
      reconnectMaxMs: options.reconnectMaxMs ?? 5000,
      batchSize: options.batchSize ?? 50,
      intervalMs: options.intervalMs ?? 200,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info('event-consumer: 启动');
    // 两条循环并行启动，互不 await；sseLoop 内部已全 catch，不会 unhandled
    void this.sseLoop().catch((err: unknown) => {
      this.log.error({ err }, 'event-consumer: SSE 循环异常退出');
    });
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.sseAbort?.abort();
    this.log.info('event-consumer: 停止');
  }

  /** 消费一批待处理事件（测试与内部复用）。 */
  async runOnce(): Promise<number> {
    return this.consumeBatch();
  }

  // ============================================================
  // SSE ingest loop
  // ============================================================

  private async sseLoop(): Promise<void> {
    let backoffMs = this.opts.reconnectBaseMs;
    while (this.running) {
      try {
        await this.ingestSse();
        // 正常退出（流关闭）→ 重置退避
        backoffMs = this.opts.reconnectBaseMs;
      } catch (err) {
        if (!this.running) break; // stop() 触发 abort 导致的异常不记
        this.log.warn(
          { err, backoffMs },
          'event-consumer: SSE 断流，退避后重连',
        );
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, this.opts.reconnectMaxMs);
      }
    }
  }

  /**
   * 建立一次 SSE 连接并持续消费到流结束/报错。
   * 返回后由外层决定是否重连。
   */
  private async ingestSse(): Promise<void> {
    const cursor = await this.inboxRepo.getCursor();
    const url = `${this.gatewayUrl}/events?since=${cursor}`;
    this.log.info({ cursor, url }, 'event-consumer: 建立 SSE 连接');

    this.sseAbort = new AbortController();
    let res: Response;
    try {
      res = await fetch(url, { signal: this.sseAbort.signal });
    } catch (err) {
      this.log.warn({ err, url }, 'event-consumer: SSE 连接失败');
      throw err;
    }
    if (!res.ok || res.body === null) {
      this.log.warn({ status: res.status, url }, 'event-consumer: SSE 非 200 响应');
      throw new Error(`SSE 连接失败: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 按空行切帧
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // 每帧一个独立 trace：覆盖「inbox 落库」这一事务的全部日志
          await withNewTrace(() => this.handleFrame(frame));
        }
      }
      // 流正常结束
      this.log.info('event-consumer: SSE 流关闭');
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 忽略 cancel 失败
      }
    }
  }

  /**
   * 解析一帧 SSE 并落库（同事务推进游标）。
   * 帧格式：`id: <eventId>\nevent: <type>\ndata: <json>\n\n`；
   * 忽略注释行（`: ping` / `: connected`）。
   */
  private async handleFrame(frame: string): Promise<void> {
    let eventId: number | null = null;
    let eventType = 'message'; // SSE 默认类型
    let dataLines: string[] = [];

    for (const line of frame.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(':')) continue; // 注释/心跳
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

      if (field === 'id') {
        eventId = Number(value);
      } else if (field === 'event') {
        eventType = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }

    if (eventId === null || Number.isNaN(eventId)) {
      this.log.warn({ frame }, 'event-consumer: 帧缺少 eventId，跳过');
      return;
    }
    if (dataLines.length === 0) {
      this.log.warn({ eventId, frame }, 'event-consumer: 帧缺少 data，跳过');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch (err) {
      this.log.error({ eventId, data: dataLines.join('\n'), err }, 'event-consumer: data 解析失败');
      return; // 丢弃畸形帧
    }

    // 同事务：INSERT events_inbox + UPDATE events_cursor
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await this.inboxRepo.ingestFrame(client, { eventId, type: eventType, payload });
      await client.query('COMMIT');
      this.log.debug({ eventId, type: eventType, inserted }, 'event-consumer: 事件已入 inbox');
    } catch (err) {
      await client.query('ROLLBACK');
      this.log.error({ eventId, type: eventType, err }, 'event-consumer: inbox 落库失败');
      throw err;
    } finally {
      client.release();
    }
  }

  // ============================================================
  // 消费 loop
  // ============================================================

  private scheduleNext(delayMs?: number): void {
    if (!this.running) return;
    const delay = delayMs ?? this.opts.intervalMs;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.consumeBatch();
    } catch (err) {
      this.log.error({ err }, 'event-consumer: 批处理异常');
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * 轮询待处理事件并逐条处理。
   * @returns 本批处理条数（成功 + 失败）
   */
  private async consumeBatch(): Promise<number> {
    const rows = await this.inboxRepo.listPending(this.opts.batchSize);
    if (rows.length === 0) return 0;

    let ok = 0;
    let failed = 0;

    for (const row of rows) {
      // 每条事件一个独立 trace：handler 内的日志、出站调用都归入该 traceId
      const success = await withNewTrace(() => this.consumeOne(row));
      if (success) ok++;
      else failed++;
    }

    this.log.debug({ total: rows.length, ok, failed }, 'event-consumer: 批处理完成');
    return rows.length;
  }

  /**
   * 处理单条事件：独立事务内 dispatch + 置 processed_at。
   * 失败则 attempts+1 + last_error + inconsistency web_event，**不中断后续**。
   * @returns true=成功，false=失败
   */
  private async consumeOne(row: InboxRow): Promise<boolean> {
    const logCtx = { eventId: row.eventId, type: row.type, attempts: row.attempts };

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ctx: HandlerContext = { client, pool: this.pool, log: this.log, media: this.mediaConfig };
      await dispatch(ctx, row.type, row.payload);
      await this.inboxRepo.markProcessed(client, row.eventId);
      await client.query('COMMIT');
      this.log.debug(logCtx, 'event-consumer: 事件处理成功');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.warn({ ...logCtx, err: errorMsg }, 'event-consumer: 事件处理失败，记录后跳过');

      // 失败记录：attempts+1 + inconsistency web_event（同事务）
      try {
        await client.query('BEGIN');
        await this.inboxRepo.markAttemptFailed(client, row.eventId, errorMsg);
        await enqueueWebEvent(client, 'inconsistency', {
          kind: 'event_handler',
          eventId: row.eventId,
          type: row.type,
          error: errorMsg,
          attempts: row.attempts + 1,
        });
        await client.query('COMMIT');
      } catch (retryErr) {
        await client.query('ROLLBACK');
        this.log.error({ ...logCtx, err: retryErr }, 'event-consumer: 失败标记写入失败');
      }
      return false;
    } finally {
      client.release();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
