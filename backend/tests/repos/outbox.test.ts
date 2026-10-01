/**
 * OutboxRepo 测试（规划 03 任务 3.2）：
 *  - enqueue：INV-1 先落库 + client_msg_id 唯一约束
 *  - claimQueued：只取 queued、只发 online 账号、FIFO 顺序、generation+1、
 *    FOR UPDATE SKIP LOCKED 并发不重复取
 *  - transitionCAS：version 乐观锁、附带列单向填充、CHECK 约束兜底
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OutboxRepo } from '../../src/repos/outbox.js';
import {
  insertOutbox,
  pool,
  queryOne,
  resetDb,
  seedGroupWithMember,
  withTx,
} from '../helpers/db.js';

describe('OutboxRepo.enqueue', () => {
  let repo: OutboxRepo;

  beforeEach(async () => {
    await resetDb();
    repo = new OutboxRepo(pool);
  });

  it('写入字段与默认值：queued / generation=0 / resendCount=0 / version=1', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const clientMsgId = randomUUID();

    const row = await repo.enqueue(pool, {
      groupId,
      accountId: accountUuid,
      clientMsgId,
      text: 'hello',
      origin: 'api',
    });

    expect(row.clientMsgId).toBe(clientMsgId);
    expect(row.text).toBe('hello');
    expect(row.deliveryStatus).toBe('queued');
    expect(row.generation).toBe(0);
    expect(row.resendCount).toBe(0);
    expect(row.version).toBe(1);
    expect(row.failCode).toBeNull();
  });

  it('client_msg_id 重复 → 唯一约束冲突（幂等键的 DB 级保证）', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const clientMsgId = randomUUID();
    await repo.enqueue(pool, { groupId, accountId: accountUuid, clientMsgId, text: 'a', origin: 'api' });

    await expect(
      repo.enqueue(pool, { groupId, accountId: accountUuid, clientMsgId, text: 'b', origin: 'api' }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe('OutboxRepo.claimQueued', () => {
  let repo: OutboxRepo;

  beforeEach(async () => {
    await resetDb();
    repo = new OutboxRepo(pool);
  });

  it('只取 queued：accepted/sent/failed/unknown/cancelled 均不取', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    for (const status of ['accepted', 'sent', 'failed', 'unknown', 'cancelled'] as const) {
      await insertOutbox(groupId, accountUuid, { status });
    }
    const queued = await insertOutbox(groupId, accountUuid, { status: 'queued' });

    const claimed = await withTx((c) => repo.claimQueued(c, 10));

    expect(claimed.map((r) => r.id)).toEqual([queued.id]);
  });

  it('只发 online 账号：rate_limited/idle/disconnected 的行保持 queued', async () => {
    // 四个账号各建一群、各插一条 queued；只有 acct-1 是 online
    const fx1 = await seedGroupWithMember('acct-1');
    const fx2 = await seedGroupWithMember('acct-2');
    const fx3 = await seedGroupWithMember('acct-3');
    const fx4 = await seedGroupWithMember('acct-4');
    const q1 = await insertOutbox(fx1.groupId, fx1.accountUuid);
    await insertOutbox(fx2.groupId, fx2.accountUuid);
    await insertOutbox(fx3.groupId, fx3.accountUuid);
    await insertOutbox(fx4.groupId, fx4.accountUuid);
    await pool.query(`UPDATE accounts SET status='rate_limited' WHERE account_id='acct-2'`);
    await pool.query(`UPDATE accounts SET status='idle' WHERE account_id='acct-3'`);
    await pool.query(`UPDATE accounts SET status='disconnected' WHERE account_id='acct-4'`);

    const claimed = await withTx((c) => repo.claimQueued(c, 10));

    expect(claimed.map((r) => r.id)).toEqual([q1.id]);
  });

  it('按 (created_at, client_msg_id) 升序返回，且 generation 0→1', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    // 显式错开 created_at（默认 now() 同语句/同事务可能相同，顺序无法区分）
    const base = Date.now();
    const third = await insertOutbox(groupId, accountUuid, { createdAt: new Date(base + 2000) });
    const first = await insertOutbox(groupId, accountUuid, { createdAt: new Date(base) });
    const second = await insertOutbox(groupId, accountUuid, { createdAt: new Date(base + 1000) });

    const claimed = await withTx((c) => repo.claimQueued(c, 10));

    expect(claimed.map((r) => r.id)).toEqual([first.id, second.id, third.id]);
    expect(claimed.every((r) => r.generation === 1)).toBe(true);

    // 库中 generation 已持久化（崩溃语义的依据）
    const row = await queryOne<{ generation: number }>(
      'SELECT generation FROM outbox_messages WHERE id = $1',
      [first.id],
    );
    expect(row?.generation).toBe(1);
  });

  it('limit 生效', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    for (let i = 0; i < 3; i++) await insertOutbox(groupId, accountUuid);

    const claimed = await withTx((c) => repo.claimQueued(c, 2));

    expect(claimed).toHaveLength(2);
  });

  it('并发两事务：FOR UPDATE SKIP LOCKED 保证同行不被重复取', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const only = await insertOutbox(groupId, accountUuid);

    const txA = await pool.connect();
    const txB = await pool.connect();
    try {
      await txA.query('BEGIN');
      await txB.query('BEGIN');

      const claimedByA = await repo.claimQueued(txA, 10);
      // A 持有的行锁未释放，B 的 SKIP LOCKED 直接跳过 → 取不到
      const claimedByB = await repo.claimQueued(txB, 10);

      expect(claimedByA.map((r) => r.id)).toEqual([only.id]);
      expect(claimedByB).toEqual([]);

      await txA.query('COMMIT');
      await txB.query('COMMIT');
    } finally {
      txA.release();
      txB.release();
    }
  });
});

describe('OutboxRepo.transitionCAS', () => {
  let repo: OutboxRepo;

  beforeEach(async () => {
    await resetDb();
    repo = new OutboxRepo(pool);
  });

  it('queued→accepted：状态与 acceptedAt 写入，version+1', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id } = await insertOutbox(groupId, accountUuid);
    const acceptedAt = new Date();

    const updated = await repo.transitionCAS(pool, id, 1, 'accepted', { acceptedAt });

    expect(updated).not.toBeNull();
    expect(updated!.deliveryStatus).toBe('accepted');
    expect(updated!.version).toBe(2);
    expect(updated!.acceptedAt?.getTime()).toBe(acceptedAt.getTime());
  });

  it('version 不匹配返回 null（CAS 冲突），行保持不变', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id } = await insertOutbox(groupId, accountUuid);

    const result = await repo.transitionCAS(pool, id, 99, 'accepted');

    expect(result).toBeNull();
    const row = await repo.findById(id);
    expect(row?.deliveryStatus).toBe('queued');
    expect(row?.version).toBe(1);
  });

  it('附带列 gatewayMsgId / sentAt / failCode 单向填充', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id } = await insertOutbox(groupId, accountUuid, { status: 'accepted' });
    const sentAt = new Date();

    const updated = await repo.transitionCAS(pool, id, 1, 'sent', {
      gatewayMsgId: 'gw-msg-1',
      sentAt,
    });

    expect(updated!.gatewayMsgId).toBe('gw-msg-1');
    expect(updated!.sentAt?.getTime()).toBe(sentAt.getTime());
  });

  it('failed 不带 failCode → DB CHECK 约束拒绝', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id } = await insertOutbox(groupId, accountUuid);

    await expect(repo.transitionCAS(pool, id, 1, 'failed')).rejects.toThrow(/violates check constraint/i);
  });

  it('不传附带列时原有值不被清空（COALESCE 语义）', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id } = await insertOutbox(groupId, accountUuid);
    await repo.transitionCAS(pool, id, 1, 'accepted', { acceptedAt: new Date() });

    // accepted→unknown（504）：不传 acceptedAt，值应保留
    const updated = await repo.transitionCAS(pool, id, 2, 'unknown');

    expect(updated!.deliveryStatus).toBe('unknown');
    expect(updated!.acceptedAt).not.toBeNull();
  });
});

describe('OutboxRepo.findByClientMsgId / findById', () => {
  let repo: OutboxRepo;

  beforeEach(async () => {
    await resetDb();
    repo = new OutboxRepo(pool);
  });

  it('按幂等键命中与未命中', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid);

    const hit = await repo.findByClientMsgId(clientMsgId);
    expect(hit?.clientMsgId).toBe(clientMsgId);

    const miss = await repo.findByClientMsgId(randomUUID());
    expect(miss).toBeUndefined();
  });

  it('按 id 命中与未命中', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id } = await insertOutbox(groupId, accountUuid);

    expect((await repo.findById(id))?.id).toBe(id);
    expect(await repo.findById(randomUUID())).toBeUndefined();
  });
});
