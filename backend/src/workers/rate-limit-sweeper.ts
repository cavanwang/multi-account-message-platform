/**
 * 限流到期恢复 worker。
 *
 * 每秒扫描一次数据库，将 rate_limited_until <= now() 的账号恢复为 online。
 * 这是崩溃安全的：不依赖内存 timer，重启后自然继续（规划 02 §3）。
 *
 * 恢复与事件入队在同一条 SQL（CTE）内完成：
 *   - UPDATE 恢复账号
 *   - 同时为每个被恢复账号插入 account_status_changed 事件
 * 保证"状态变为 online"与"前端可见事件"同时落库（INV-5）。
 *
 * 到期时若账号已不是 rate_limited（WHERE 条件不匹配）自然不会被恢复。
 */
import type { Pool } from 'pg';
import { withNewTrace } from '../services/trace.js';

export interface RateLimitSweeperOptions {
  /** 扫描间隔（毫秒），默认 1000。 */
  intervalMs?: number;
  /** 恢复账号后的回调（切片 4 用于实时通知 WS；事件本身已落库，断线可补齐）。 */
  onRecover?: (accountId: string) => void;
}

/** 恢复并补发事件的 SQL：UPDATE 与 INSERT 在同一语句的隐式事务内原子提交。 */
const SWEEP_SQL = `
  WITH recovered AS (
    UPDATE accounts
    SET status = 'online',
        rate_limited_until = NULL,
        retry_after_seconds = NULL,
        version = version + 1,
        updated_at = now()
    WHERE status = 'rate_limited'
      AND rate_limited_until <= now()
    RETURNING account_id
  )
  INSERT INTO web_events (type, payload)
  SELECT 'account_status_changed',
         jsonb_build_object('accountId', account_id, 'from', 'rate_limited', 'to', 'online')
  FROM recovered
  RETURNING jsonb_extract_path_text(payload, 'accountId') AS account_id
`;

export class RateLimitSweeper {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly options: RateLimitSweeperOptions = {},
  ) {}

  /**
   * 启动 worker。
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * 停止 worker（优雅关闭）。
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const intervalMs = this.options.intervalMs ?? 1000;
    this.timer = setTimeout(() => void this.sweep(), intervalMs);
  }

  private async sweep(): Promise<void> {
    // 每轮扫描一个 trace：恢复回调（WS 推送等）链路日志归入该 traceId
    await withNewTrace(async () => {
      const { rows } = await this.pool.query<{ account_id: string }>(SWEEP_SQL);
      for (const row of rows) {
        this.options.onRecover?.(row.account_id);
      }
    }).catch((err) => {
      // 记录错误但不中断 worker：下一轮扫描会重试，到期恢复天然幂等
      console.error('[RateLimitSweeper] sweep 失败:', err);
    });
    this.scheduleNext();
  }
}
