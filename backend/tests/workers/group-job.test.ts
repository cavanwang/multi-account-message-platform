/**
 * GroupJobWorker 测试（规划 04 任务 4.3-4.6）。
 *
 * 覆盖：
 *  - happy path：create → invite → join → promote → finished，role 序列正确
 *  - INVITE_NOT_READY → 等待 readyAfterMs 后成功
 *  - INVITE_EXPIRED → 清除旧链接，重新申请后成功
 *  - ALREADY_MEMBER → 直接 joined，promote 照常
 *  - JOIN_TIMEOUT → 10s 后 job failed
 *  - promote NOT_MEMBER_YET → 恰 2 次后 failed
 *  - create 业务错误 → 记 errors → failed
 *  - 崩溃续跑：createGroup 只调 1 次
 *  - member_joined handler：名单第一个 → admin，非名单 → member 不变
 *
 * 网关用假实现，无需真实容器。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { GroupGateway, GroupResult, LoggerLike } from '../../src/services/gateway-client.js';
import { GroupJobWorker } from '../../src/workers/group-job.js';
import { JobRepo } from '../../src/repos/jobs.js';
import { GroupRepo } from '../../src/repos/groups.js';
import { AccountRepo } from '../../src/repos/accounts.js';
import { handleMemberJoined } from '../../src/services/event-handlers/member-joined.js';
import type { MediaConfig } from '../../src/services/event-handlers/types.js';
import { pool, queryOne, resetDb } from '../helpers/db.js';

const silentLog: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 测试用媒体配置：member_joined handler 不使用其中字段，满足 HandlerContext 即可。 */
const TEST_MEDIA_CONFIG: MediaConfig = {
  mediaDir: '/tmp/mamp-media-unused',
  mediaRetentionDays: 30,
  mediaCleanIntervalSeconds: 3600,
  gatewayUrl: 'http://unused',
};

class FakeGroupGateway implements GroupGateway {
  createGroupCalls: string[] = [];
  createInviteCalls: string[] = [];
  joinCalls: Array<{ groupId: string; accountId: string; inviteLink: string }> = [];
  promoteCalls: Array<{ groupId: string; byAccountId: string; accountId: string }> = [];

  createGroupResult: GroupResult<{ groupId: string }> = {
    kind: 'ok',
    data: { groupId: 'gw-grp-1' },
  };
  createInviteResult: GroupResult<{ inviteLink: string; readyAfterMs: number }> = {
    kind: 'ok',
    data: { inviteLink: 'https://invite.mock/1', readyAfterMs: 0 },
  };
  joinResult: GroupResult = { kind: 'ok', data: undefined };
  promoteResult: GroupResult = { kind: 'ok', data: undefined };

  async createGroup(creatorAccountId: string): Promise<GroupResult<{ groupId: string }>> {
    this.createGroupCalls.push(creatorAccountId);
    return this.createGroupResult;
  }

  async createInvite(
    gatewayGroupId: string,
    _options?: { readyAfterMs?: number; ttlMs?: number },
  ): Promise<GroupResult<{ inviteLink: string; readyAfterMs: number }>> {
    this.createInviteCalls.push(gatewayGroupId);
    return this.createInviteResult;
  }

  async join(
    gatewayGroupId: string,
    accountId: string,
    inviteLink: string,
  ): Promise<GroupResult> {
    this.joinCalls.push({ groupId: gatewayGroupId, accountId, inviteLink });
    return this.joinResult;
  }

  async promote(
    gatewayGroupId: string,
    byAccountId: string,
    accountId: string,
  ): Promise<GroupResult> {
    this.promoteCalls.push({ groupId: gatewayGroupId, byAccountId, accountId });
    return this.promoteResult;
  }

  // 建群 worker 不会用到 kick/leave，提供空实现满足接口
  async kickMember(): Promise<GroupResult> {
    throw new Error('not implemented');
  }

  async leaveMember(): Promise<GroupResult> {
    throw new Error('not implemented');
  }
}

function makeWorker(gw: GroupGateway, intervalMs = 1000): GroupJobWorker {
  return new GroupJobWorker(pool, gw, silentLog, intervalMs);
}

async function seedOnlineAccount(accountId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE accounts SET status='online', platform_user_id='pu_' || account_id
     WHERE account_id=$1 RETURNING id`,
    [accountId],
  );
  return rows[0]!.id;
}

async function createJob(
  creatorAccountId: string,
  memberAccountIds: string[],
): Promise<string> {
  const jobRepo = new JobRepo(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobId = await jobRepo.createCreateGroupJob(client, {
      creatorAccountUuid: (await new AccountRepo(pool).findByAccountId(creatorAccountId))!.id,
      memberAccountUuids: await Promise.all(
        memberAccountIds.map(async (id) => (await new AccountRepo(pool).findByAccountId(id))!.id),
      ),
      payload: { creatorAccountId, memberAccountIds },
    });
    await client.query('COMMIT');
    return jobId;
  } finally {
    client.release();
  }
}

describe('GroupJobWorker', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('happy path：create → invite → join → promote → finished', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    await seedOnlineAccount('acct-3');
    const jobId = await createJob('acct-1', ['acct-2', 'acct-3']);

    const gw = new FakeGroupGateway();
    const worker = makeWorker(gw);

    // create
    await worker.runOnce();
    expect(gw.createGroupCalls).toEqual(['acct-1']);
    const group = await queryOne<{ gateway_group_id: string }>(
      'SELECT * FROM groups WHERE created_by_job_id = $1',
      [jobId],
    );
    expect(group).toBeDefined();

    // invite
    await worker.runOnce();
    expect(gw.createInviteCalls).toEqual(['gw-grp-1']);
    const jobRepo = new JobRepo(pool);
    let job = await jobRepo.findById(jobId);
    expect(job!.payload['inviteLink']).toBe('https://invite.mock/1');

    // join
    await worker.runOnce();
    expect(gw.joinCalls).toHaveLength(2);
    const members = await jobRepo.listJobMembers(jobId);
    expect(members.every((m) => m.joinRequestedAt !== null)).toBe(true);

    // 模拟 member_joined 到达（worker 里 join 只受理，不入群）
    await pool.query(
      `UPDATE group_job_members SET joined_at = now() WHERE job_id = $1`,
      [jobId],
    );

    // promote
    await worker.runOnce();
    expect(gw.promoteCalls).toEqual([
      { groupId: 'gw-grp-1', byAccountId: 'acct-1', accountId: 'acct-2' },
    ]);
    job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('finished');
  });

  it('INVITE_NOT_READY → 等待后成功', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    await createJob('acct-1', ['acct-2']);

    const gw = new FakeGroupGateway();
    gw.createInviteResult = {
      kind: 'ok',
      data: { inviteLink: 'https://invite.mock/1', readyAfterMs: 100 },
    };
    const worker = makeWorker(gw, 10);

    await worker.runOnce(); // create
    await worker.runOnce(); // invite
    await worker.runOnce(); // join 应跳过（还没 ready）
    expect(gw.joinCalls).toHaveLength(0);

    // 等 ready
    await new Promise((r) => setTimeout(r, 150));
    await worker.runOnce(); // join
    expect(gw.joinCalls).toHaveLength(1);
  });

  it('INVITE_EXPIRED → 清除旧链接，重新申请后成功', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    const jobId = await createJob('acct-1', ['acct-2']);

    const gw = new FakeGroupGateway();
    // 提前设置 join 返回 INVITE_EXPIRED，这样第 2 次 runOnce 的 stepJoin 会触发
    gw.joinResult = { kind: 'error', status: 410, code: 'INVITE_EXPIRED' };
    const worker = makeWorker(gw, 10);

    await worker.runOnce(); // create
    await worker.runOnce(); // invite → join → INVITE_EXPIRED → 清除链接

    const jobRepo = new JobRepo(pool);
    let job = await jobRepo.findById(jobId);
    // 清除链接后 payload 中 inviteLink 应消失
    expect(job!.payload['inviteLink']).toBeUndefined();

    // 恢复 join 成功，重新 invite + join
    gw.joinResult = { kind: 'ok', data: undefined };
    await worker.runOnce(); // invite（重新申请链接；stepJoin 仍用旧快照 payload，本 tick 不 join）
    await worker.runOnce(); // join（本 tick 快照含新 inviteLink，真正发起 join）
    expect(gw.joinCalls).toHaveLength(2);
    job = await jobRepo.findById(jobId);
    expect(job!.payload['inviteLink']).toBe('https://invite.mock/1');
    const members = await jobRepo.listJobMembers(jobId);
    expect(members[0]!.joinRequestedAt).not.toBeNull();
  });

  it('ALREADY_MEMBER → 直接 joined，promote 照常', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    const jobId = await createJob('acct-1', ['acct-2']);

    const gw = new FakeGroupGateway();
    gw.joinResult = { kind: 'error', status: 409, code: 'ALREADY_MEMBER' };
    const worker = makeWorker(gw, 10);

    await worker.runOnce(); // create
    await worker.runOnce(); // invite
    await worker.runOnce(); // join → ALREADY_MEMBER → markJoined

    const jobRepo = new JobRepo(pool);
    const members = await jobRepo.listJobMembers(jobId);
    expect(members[0]!.joinedAt).not.toBeNull();

    // promote 应继续
    await worker.runOnce();
    expect(gw.promoteCalls).toHaveLength(1);
    const job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('finished');
  });

  it('JOIN_TIMEOUT：join_requested_at 超过 10s 无 joined → job failed', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    const jobId = await createJob('acct-1', ['acct-2']);

    const gw = new FakeGroupGateway();
    const worker = makeWorker(gw, 10);

    await worker.runOnce(); // create
    await worker.runOnce(); // invite
    await worker.runOnce(); // join 受理

    // 手动把 join_requested_at 拨回 11 秒前
    await pool.query(
      `UPDATE group_job_members SET join_requested_at = now() - interval '11 seconds'
       WHERE job_id = $1`,
      [jobId],
    );

    await worker.runOnce(); // 应触发 JOIN_TIMEOUT

    const jobRepo = new JobRepo(pool);
    const job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('failed');
    expect(job!.errors).toEqual([{ step: 'join:' + (await new AccountRepo(pool).findByAccountId('acct-2'))!.id, code: 'JOIN_TIMEOUT' }]);
  });

  it('promote NOT_MEMBER_YET：恰 2 次后 job failed', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    const jobId = await createJob('acct-1', ['acct-2']);

    const gw = new FakeGroupGateway();
    const worker = makeWorker(gw, 10);

    await worker.runOnce(); // create
    await worker.runOnce(); // invite
    await worker.runOnce(); // join
    await pool.query(`UPDATE group_job_members SET joined_at = now() WHERE job_id = $1`, [jobId]);

    gw.promoteResult = { kind: 'error', status: 409, code: 'NOT_MEMBER_YET' };
    await worker.runOnce(); // promote 第 1 次
    await worker.runOnce(); // promote 第 2 次
    await worker.runOnce(); // 第 3 次应不再调用，直接 failed

    expect(gw.promoteCalls).toHaveLength(2);
    const job = await new JobRepo(pool).findById(jobId);
    expect(job!.status).toBe('failed');
    expect(job!.errors).toEqual([{ step: 'promote', code: 'NOT_MEMBER_YET' }]);
  });

  it('create 业务错误 → 记 errors → job failed', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    const jobId = await createJob('acct-1', ['acct-2']);

    const gw = new FakeGroupGateway();
    gw.createGroupResult = { kind: 'error', status: 409, code: 'ACCOUNT_OFFLINE' };
    const worker = makeWorker(gw, 10);

    await worker.runOnce();

    const job = await new JobRepo(pool).findById(jobId);
    expect(job!.status).toBe('failed');
    expect(job!.errors).toEqual([{ step: 'create', code: 'ACCOUNT_OFFLINE' }]);
  });

  it('崩溃续跑：createGroup 只调 1 次', async () => {
    await seedOnlineAccount('acct-1');
    await seedOnlineAccount('acct-2');
    await createJob('acct-1', ['acct-2']);

    const gw = new FakeGroupGateway();
    const worker = makeWorker(gw, 10);

    await worker.runOnce(); // create
    expect(gw.createGroupCalls).toHaveLength(1);

    // 模拟重启后再次 runOnce
    await worker.runOnce();
    expect(gw.createGroupCalls).toHaveLength(1);
  });

  it('member_joined handler：名单第一个 → admin，非名单 → member 不变', async () => {
    await seedOnlineAccount('acct-1');
    const m1Uuid = await seedOnlineAccount('acct-2');
    const m2Uuid = await seedOnlineAccount('acct-3');
    const jobId = await createJob('acct-1', ['acct-2', 'acct-3']);

    const gw = new FakeGroupGateway();
    const worker = makeWorker(gw, 10);

    await worker.runOnce(); // create
    await worker.runOnce(); // invite
    await worker.runOnce(); // join

    // 模拟 member_joined：acct-2 是名单第一个 → admin
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ctx = { client, pool, log: silentLog, media: TEST_MEDIA_CONFIG };
      await handleMemberJoined(ctx, { groupId: 'gw-grp-1', platformUserId: 'pu_acct-2' });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const groupRepo = new GroupRepo(pool);
    const group = await groupRepo.findByJobId(jobId);
    const members = await pool.query<{ account_id: string; role: string }>(
      'SELECT * FROM group_members WHERE group_id = $1',
      [group!.id],
    );
    const m1 = members.rows.find((r) => r.account_id === m1Uuid);
    expect(m1!.role).toBe('admin');

    // acct-3 不是名单第一个 → member
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      const ctx = { client: client2, pool, log: silentLog, media: TEST_MEDIA_CONFIG };
      await handleMemberJoined(ctx, { groupId: 'gw-grp-1', platformUserId: 'pu_acct-3' });
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }

    const members2 = await pool.query<{ account_id: string; role: string }>(
      'SELECT * FROM group_members WHERE group_id = $1',
      [group!.id],
    );
    const m2 = members2.rows.find((r) => r.account_id === m2Uuid);
    expect(m2!.role).toBe('member');
  });
});
