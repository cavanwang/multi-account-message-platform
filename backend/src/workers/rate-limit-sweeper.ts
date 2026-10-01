/**
 * 限流到期恢复 worker。
 *
 * 每秒扫描一次数据库，将 rate_limited_until <= now() 的账号恢复为 online。
 * 这是崩溃安全的：不依赖内存 timer，重启后自然继续。
 *
 * 需求 §5 A1：
 *   - rate_limited 由 RATE_LIMITED 触发，retryAfterSeconds 后自动回到 online
 *   - 到期时若账号已不是 rate_limited（被操作员标记离线等）则不做转移
 */
import type { Pool } from 'pg';
import type { AccountRepo } from '../repos/accounts.js';

export interface RateLimitSweeperOptions {
  /** 扫描间隔（毫秒），默认 1000。 */
  intervalMs?: number;
  /** 是否已启动（用于优雅关闭）。 */
  onStart?: () => void;
  /** 恢复账号后的回调（用于推送 WS 事件）。 */
  onRecover?: (accountId: string) => void;
}

export class RateLimitSweeper {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly repo: AccountRepo,
    private readonly options: RateLimitSweeperOptions = {},
  ) {}

  /**
   * 启动 worker。
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.onStart?.();
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
    try {
      const recoveredIds = await this.sweepExpiredRateLimits();
      for (const accountId of recoveredIds) {
        this.options.onRecover?.(accountId);
      }
    } catch (err) {
      // 记录错误但不中断 worker
      console.error('[RateLimitSweeper] sweep 失败:', err);
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * 扫描并恢复过期的限流账号。
   * @returns 被恢复的账号 ID 列表
   */
  private async sweepExpiredRateLimits(): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string; account_id: string }>(
      `UPDATE accounts
       SET status = 'online',
           rate_limited_until = NULL,
           retry_after_seconds = NULL,
           version = version + 1,
           updated_at = now()
       WHERE status = 'rate_limited'
         AND rate_limited_until <= now()
       RETURNING id, account_id`,
    );
    return rows.map((r) => r.account_id);
  }
}
