/**
 * 限流到期恢复 worker 测试（规划 02 §7）：
 *  - 已到期：≤2 秒内自动回 online、清空 until/retry_after、入队事件、触发回调
 *  - 未到期：保持 rate_limited，无事件
 *  - 到期前已被操作员改为 disconnected：不自动恢复
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimitSweeper } from '../../src/workers/rate-limit-sweeper.js';
import { pool, queryMany, queryOne, resetDb } from '../helpers/db.js';

async function setRateLimited(accountId: string, untilOffsetSeconds: number): Promise<void> {
  await pool.query(
    `UPDATE accounts
       SET status='rate_limited',
           rate_limited_until = now() + make_interval(secs => $2),
           retry_after_seconds = 5
     WHERE account_id=$1`,
    [accountId, untilOffsetSeconds],
  );
}

async function statusOf(accountId: string): Promise<{
  status: string;
  rate_limited_until: Date | null;
  retry_after_seconds: number | null;
}> {
  const row = await queryOne<{
    status: string;
    rate_limited_until: Date | null;
    retry_after_seconds: number | null;
  }>(
    `SELECT status, rate_limited_until, retry_after_seconds
       FROM accounts WHERE account_id=$1`,
    [accountId],
  );
  return row!;
}

/** 轮询断言：默认每 50ms 检查一次，最多 2 秒。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时，条件始终未满足');
}

describe('RateLimitSweeper', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('已到期：自动恢复 online，清空限流字段，入队 rate_limited→online 事件并回调', async () => {
    await setRateLimited('acct-1', -2);
    const recovered: string[] = [];
    const sweeper = new RateLimitSweeper(pool, { intervalMs: 50, onRecover: (id) => recovered.push(id) });
    sweeper.start();
    try {
      await waitFor(async () => (await statusOf('acct-1')).status === 'online');

      const row = await statusOf('acct-1');
      expect(row.status).toBe('online');
      expect(row.rate_limited_until).toBeNull();
      expect(row.retry_after_seconds).toBeNull();

      // 恢复只发生一次：稳定后事件恰有一条
      await new Promise((r) => setTimeout(r, 200));
      const events = await queryMany<{ from_s: string; to_s: string }>(
        `SELECT payload->>'from' AS from_s, payload->>'to' AS to_s
           FROM web_events WHERE payload->>'accountId'='acct-1' ORDER BY seq`,
      );
      expect(events).toEqual([{ from_s: 'rate_limited', to_s: 'online' }]);
      expect(recovered).toEqual(['acct-1']);
    } finally {
      sweeper.stop();
    }
  });

  it('未到期：保持 rate_limited，无事件、无回调', async () => {
    await setRateLimited('acct-2', 60);
    const recovered: string[] = [];
    const sweeper = new RateLimitSweeper(pool, { intervalMs: 50, onRecover: (id) => recovered.push(id) });
    sweeper.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      const row = await statusOf('acct-2');
      expect(row.status).toBe('rate_limited');
      expect(recovered).toEqual([]);
      const events = await queryMany<{ seq: string }>(
        `SELECT seq::text FROM web_events WHERE payload->>'accountId'='acct-2'`,
      );
      expect(events).toEqual([]);
    } finally {
      sweeper.stop();
    }
  });

  it('到期前已被标记 disconnected：即使 until 已过也不恢复', async () => {
    await setRateLimited('acct-3', -2);
    // 操作员在到期窗口前把账号改为 disconnected
    await pool.query(
      `UPDATE accounts SET status='disconnected', rate_limited_until=now()-interval '2 second'
       WHERE account_id='acct-3'`,
    );

    const recovered: string[] = [];
    const sweeper = new RateLimitSweeper(pool, { intervalMs: 50, onRecover: (id) => recovered.push(id) });
    sweeper.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      const row = await statusOf('acct-3');
      // WHERE status='rate_limited' 保护：非限流态不被扫到
      expect(row.status).toBe('disconnected');
      expect(recovered).toEqual([]);
    } finally {
      sweeper.stop();
    }
  });
});
