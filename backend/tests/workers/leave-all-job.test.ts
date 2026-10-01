/**
 * LeaveAllJobWorker 测试（B2 群生命周期）。
 *
 * 覆盖：
 *   - happy path：非群主先退、群主后退 → finished，群 status='left'
 *   - 非群主 500 失败 → errors[]，其余非群主继续退，群主不退，job failed
 *   - 多个非群主部分失败 → 同上
 *   - 403 SENDER_NOT_IN_GROUP → 视为已退，直接删行继续
 *   - network 异常 → 下 tick 重试，不记 errors
 *   - 群主退群失败 → job failed
 *   - 幂等：同一 tick 不会重复 leave 已退成员
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { GroupGateway, GroupResult, LoggerLike } from '../../src/services/gateway-client.js';
import { LeaveAllJobWorker } from '../../src/workers/leave-all-job.js';
import { JobRepo } from '../../src/repos/jobs.js';
import { GroupRepo } from '../../src/repos/groups.js';
import { pool, resetDb } from '../helpers/db.js';
import { randomUUID } from 'node:crypto';

const silentLog: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeGroupGateway implements GroupGateway {
  createGroupCalls: string[] = [];
  createInviteCalls: string[] = [];
  joinCalls: Array<{ groupId: string; accountId: string; inviteLink: string }> = [];
  promoteCalls: Array<{ groupId: string; byAccountId: string; accountId: string }> = [];
  kickMemberCalls: Array<{ groupId: string; byAccountId: string; targetPlatformUserId: string }> = [];
  leaveMemberCalls: Array<{ groupId: string; accountId: string }> = [];

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
  kickMemberResult: GroupResult = { kind: 'ok', data: undefined };
  leaveMemberResult: GroupResult = { kind: 'ok', data: undefined };

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

  async kickMember(
    gatewayGroupId: string,
    byAccountId: string,
    targetPlatformUserId: string,
  ): Promise<GroupResult> {
    this.kickMemberCalls.push({ groupId: gatewayGroupId, byAccountId, targetPlatformUserId });
    return this.kickMemberResult;
  }

  async leaveMember(gatewayGroupId: string, accountId: string): Promise<GroupResult> {
    this.leaveMemberCalls.push({ groupId: gatewayGroupId, accountId });
    return this.leaveMemberResult;
  }
}

function makeWorker(gw: GroupGateway, intervalMs = 1000): LeaveAllJobWorker {
  return new LeaveAllJobWorker(pool, gw, silentLog, intervalMs);
}

async function seedOnlineAccount(accountId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE accounts SET status='online', platform_user_id='pu_' || account_id
     WHERE account_id=$1 RETURNING id`,
    [accountId],
  );
  return rows[0]!.id;
}

async function seedGroupWithMembers(
  creatorAccountId: string,
  memberAccountIds: string[],
): Promise<{ groupId: string; gatewayGroupId: string }> {
  const creatorUuid = await seedOnlineAccount(creatorAccountId);
  const memberUuids = await Promise.all(memberAccountIds.map(seedOnlineAccount));
  const gatewayGroupId = `gw_${randomUUID()}`;

  const { rows: groupRows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (gateway_group_id, creator_account_id, status, version)
     VALUES ($1, $2, 'active', 1) RETURNING id`,
    [gatewayGroupId, creatorUuid],
  );
  const groupId = groupRows[0]!.id;

  // 群主
  await pool.query(
    `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
     VALUES ($1, $2, $3, 'creator')`,
    [groupId, creatorUuid, `pu_${creatorAccountId}`],
  );

  // 成员
  for (let i = 0; i < memberUuids.length; i++) {
    await pool.query(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [groupId, memberUuids[i], `pu_${memberAccountIds[i]}`],
    );
  }

  return { groupId, gatewayGroupId };
}

async function createLeaveAllJob(groupId: string, gatewayGroupId: string): Promise<string> {
  const jobRepo = new JobRepo(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobId = await jobRepo.createLeaveAllJob(client, { groupId, gatewayGroupId });
    await client.query('COMMIT');
    return jobId;
  } finally {
    client.release();
  }
}

describe('LeaveAllJobWorker', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('happy path：非群主先退，群主最后退，单 tick 内 finished', async () => {
    const gw = new FakeGroupGateway();
    const { groupId, gatewayGroupId } = await seedGroupWithMembers('acct-1', ['acct-2', 'acct-3']);
    const jobId = await createLeaveAllJob(groupId, gatewayGroupId);

    const worker = makeWorker(gw, 1000);
    await worker.runOnce();

    // 3 次 leave：前两个是非群主（顺序按内部 UUID 字典序，不定），最后一个是群主
    expect(gw.leaveMemberCalls).toHaveLength(3);
    const firstTwo = gw.leaveMemberCalls.slice(0, 2).map((c) => c.accountId).sort();
    expect(firstTwo).toEqual(['acct-2', 'acct-3']);
    expect(gw.leaveMemberCalls[2]!.accountId).toBe('acct-1');

    const jobRepo = new JobRepo(pool);
    const job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('finished');
    expect(job!.errors).toHaveLength(0);

    // 群状态变为 left
    const groupRepo = new GroupRepo(pool);
    const group = await groupRepo.findById(groupId);
    expect(group!.status).toBe('left');

    // DB 成员已清空
    const members = await groupRepo.listMembers(groupId);
    expect(members).toHaveLength(0);
  });

  it('非群主持续 500：前 2 次跨 tick 重试（running/无 errors），第 3 次后 job failed', async () => {
    const gw = new FakeGroupGateway();
    gw.leaveMemberResult = { kind: 'ok', data: undefined };
    // 让 acct-2 持续失败；acct-3 正常
    gw.leaveMember = async (groupId: string, accountId: string) => {
      gw.leaveMemberCalls.push({ groupId, accountId });
      if (accountId === 'acct-2') {
        return { kind: 'error', status: 500, code: 'INTERNAL_ERROR' };
      }
      return { kind: 'ok', data: undefined };
    };

    const { groupId, gatewayGroupId } = await seedGroupWithMembers('acct-1', ['acct-2', 'acct-3']);
    const jobId = await createLeaveAllJob(groupId, gatewayGroupId);

    const worker = makeWorker(gw, 1000);

    // tick 1：acct-2 attempts=1 重试；acct-3 成功；群主等待
    await worker.runOnce();
    // tick 2：acct-2 attempts=2 重试；群主等待
    await worker.runOnce();
    let job = await new JobRepo(pool).findById(jobId);
    expect(job!.status).toBe('running');
    expect(job!.errors).toHaveLength(0);
    expect((job!.payload['leaveRetries'] as Record<string, number>)['acct-2']).toBe(2);

    // tick 3：attempts=3 重试耗尽 → errors[]，群主不退，job failed
    await worker.runOnce();
    job = await new JobRepo(pool).findById(jobId);
    expect(job!.status).toBe('failed');
    // 第 1 条：非群主失败原因；第 2 条：汇总失败（群主不退）
    expect(job!.errors).toHaveLength(2);
    expect(job!.errors[0]!.step).toBe('leave:acct-2');
    expect(job!.errors[0]!.code).toBe('INTERNAL_ERROR');
    expect(job!.errors[1]!.code).toBe('NON_OWNER_LEAVE_FAILED');

    // acct-3 已退，acct-2 和群主仍在
    const remainingPids = (await new GroupRepo(pool).listMembers(groupId)).map((m) => m.platformUserId);
    expect(remainingPids).toContain('pu_acct-1');
    expect(remainingPids).toContain('pu_acct-2');
    expect(remainingPids).not.toContain('pu_acct-3');
  });

  it('非群主前两次 500、第三次成功 → 重试后 finished，无 errors', async () => {
    const gw = new FakeGroupGateway();
    // acct-2：失败 2 次后成功
    let acct2Fails = 0;
    gw.leaveMember = async (groupId: string, accountId: string) => {
      gw.leaveMemberCalls.push({ groupId, accountId });
      if (accountId === 'acct-2') {
        acct2Fails++;
        if (acct2Fails <= 2) return { kind: 'error', status: 500, code: 'INTERNAL_ERROR' };
      }
      return { kind: 'ok', data: undefined };
    };

    const { groupId, gatewayGroupId } = await seedGroupWithMembers('acct-1', ['acct-2']);
    const jobId = await createLeaveAllJob(groupId, gatewayGroupId);

    const worker = makeWorker(gw, 1000);
    await worker.runOnce(); // 500 attempts=1
    await worker.runOnce(); // 500 attempts=2
    await worker.runOnce(); // 成功 → 群主退 → finished

    const job = await new JobRepo(pool).findById(jobId);
    expect(job!.status).toBe('finished');
    expect(job!.errors).toHaveLength(0);
  });

  it('403 SENDER_NOT_IN_GROUP → 视为已退，直接删行继续', async () => {
    const gw = new FakeGroupGateway();
    gw.leaveMemberResult = { kind: 'error', status: 403, code: 'SENDER_NOT_IN_GROUP' };

    const { groupId, gatewayGroupId } = await seedGroupWithMembers('acct-1', ['acct-2']);
    const jobId = await createLeaveAllJob(groupId, gatewayGroupId);

    const worker = makeWorker(gw, 1000);
    await worker.runOnce();

    // 单 tick 内：acct-2 视为已退，群主随后退
    expect(gw.leaveMemberCalls).toHaveLength(2);
    expect(gw.leaveMemberCalls[0]!.accountId).toBe('acct-2');
    expect(gw.leaveMemberCalls[1]!.accountId).toBe('acct-1');

    const jobRepo = new JobRepo(pool);
    const job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('finished');
    expect(job!.errors).toHaveLength(0);
  });

  it('network 异常 → 下 tick 重试，不记 errors', async () => {
    const gw = new FakeGroupGateway();
    gw.leaveMemberResult = { kind: 'network', status: 503, code: 'SERVICE_UNAVAILABLE' };

    const { groupId, gatewayGroupId } = await seedGroupWithMembers('acct-1', ['acct-2']);
    const jobId = await createLeaveAllJob(groupId, gatewayGroupId);

    const worker = makeWorker(gw, 1000);
    await worker.runOnce();

    // 第一次 tick 调用 leave，network 返回，不记 errors
    expect(gw.leaveMemberCalls).toHaveLength(1);

    const jobRepo = new JobRepo(pool);
    let job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('running');
    expect(job!.errors).toHaveLength(0);

    // 恢复网络正常
    gw.leaveMemberResult = { kind: 'ok', data: undefined };
    await worker.runOnce();

    // 单 tick 内：非群主退成功 + 群主退
    expect(gw.leaveMemberCalls).toHaveLength(3);

    job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('finished');
  });

  it('群主持续 500：前 2 次跨 tick 重试，第 3 次后 job failed', async () => {
    const gw = new FakeGroupGateway();
    gw.leaveMemberResult = { kind: 'ok', data: undefined };
    // 让群主持续失败
    gw.leaveMember = async (groupId: string, accountId: string) => {
      gw.leaveMemberCalls.push({ groupId, accountId });
      if (accountId === 'acct-1') {
        return { kind: 'error', status: 500, code: 'INTERNAL_ERROR' };
      }
      return { kind: 'ok', data: undefined };
    };

    const { groupId, gatewayGroupId } = await seedGroupWithMembers('acct-1', ['acct-2']);
    const jobId = await createLeaveAllJob(groupId, gatewayGroupId);

    const worker = makeWorker(gw, 1000);
    // 非群主在同 tick 退成功，群主 500 attempts=1
    await worker.runOnce();
    // attempts=2，仍 running
    await worker.runOnce();
    let job = await new JobRepo(pool).findById(jobId);
    expect(job!.status).toBe('running');
    expect(job!.errors).toHaveLength(0);
    expect((job!.payload['leaveRetries'] as Record<string, number>)['acct-1']).toBe(2);

    // attempts=3 耗尽 → failed
    await worker.runOnce();
    job = await new JobRepo(pool).findById(jobId);
    expect(job!.status).toBe('failed');
    expect(job!.errors).toHaveLength(1);
    expect(job!.errors[0]!.step).toBe('leave:owner');
    expect(job!.errors[0]!.code).toBe('INTERNAL_ERROR');
  });

  it('所有成员已提前退完 → 直接 finished', async () => {
    const gw = new FakeGroupGateway();
    const { groupId, gatewayGroupId } = await seedGroupWithMembers('acct-1', []);
    const jobId = await createLeaveAllJob(groupId, gatewayGroupId);

    // 手动清空成员（模拟全部已退）
    await pool.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);

    const worker = makeWorker(gw, 1000);
    await worker.runOnce();

    // 没有调用任何 leave
    expect(gw.leaveMemberCalls).toHaveLength(0);

    const jobRepo = new JobRepo(pool);
    const job = await jobRepo.findById(jobId);
    expect(job!.status).toBe('finished');
  });
});
