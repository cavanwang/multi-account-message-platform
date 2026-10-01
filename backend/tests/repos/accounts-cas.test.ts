/**
 * CAS 乐观锁并发测试（规划 02 §7：两个并发 transition 带同一 expectedFrom
 * → 恰好一个成功、一个 CAS_CONFLICT，最终状态无覆盖）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountRepo } from '../../src/repos/accounts.js';
import { pool, resetDb } from '../helpers/db.js';

describe('AccountRepo.transitionCAS 并发语义', () => {
  let repo: AccountRepo;

  beforeEach(async () => {
    await resetDb();
    repo = new AccountRepo(pool);
  });

  it('同一 version 的两个并发更新：恰一成一败，最终 version=2 且状态=成功者目标', async () => {
    // 两个请求都读到 version=1，分别想改成 disconnected 和 rate_limited
    const [toDisconnected, toRateLimited] = await Promise.all([
      repo.transitionCAS('acct-1', 1, 'disconnected'),
      repo.transitionCAS('acct-1', 1, 'rate_limited'),
    ]);

    const results = [toDisconnected, toRateLimited];
    const succeeded = results.filter((r) => r !== null);
    const failed = results.filter((r) => r === null);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const winner = succeeded[0]!;
    expect(winner.version).toBe(2);

    // 库里最终状态必须是成功者写入的那个，没有被失败者覆盖
    const finalRow = await repo.findByAccountId('acct-1');
    expect(finalRow?.status).toBe(winner.status);
    expect(finalRow?.version).toBe(2);
  });

  it('失败方用最新 version 重试后成功，version 走到 3', async () => {
    const first = await repo.transitionCAS('acct-1', 1, 'online', {
      platformUserId: 'pu_acct_1',
    });
    expect(first).not.toBeNull();

    // 旧 version 的并发更新失败
    const stale = await repo.transitionCAS('acct-1', 1, 'disconnected');
    expect(stale).toBeNull();

    // 重新读取拿到 version=2，重试成功
    const current = await repo.findByAccountId('acct-1');
    expect(current?.version).toBe(2);
    const retried = await repo.transitionCAS('acct-1', current!.version, 'disconnected');
    expect(retried?.status).toBe('disconnected');
    expect(retried?.version).toBe(3);

    // platformUserId 不被未传该字段的更新覆盖（COALESCE 语义）
    expect(retried?.platformUserId).toBe('pu_acct_1');
  });

  it('账号不存在时返回 null（而非抛错）', async () => {
    const result = await repo.transitionCAS('acct-nope', 1, 'online');
    expect(result).toBeNull();
  });
});
