/**
 * 定时序列运行服务测试（规划 05 §3）。
 *
 * 覆盖：预检、黏性变量、账号选择、启动运行、执行步骤。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, resetDb, seedGroupWithMember } from '../helpers/db.js';
import { SequenceRepo, type SequenceStepDef } from '../../src/repos/sequences.js';
import { GroupRepo } from '../../src/repos/groups.js';
import { AccountRepo } from '../../src/repos/accounts.js';
import { OutboxRepo } from '../../src/repos/outbox.js';
import {
  preflight,
  computeStickyVars,
  resolveText,
  selectAccount,
  startSequenceRun,
  executeDueStep,
  type SequenceRunnerDeps,
} from '../../src/services/sequence-runner.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeDeps(): SequenceRunnerDeps {
  return {
    pool,
    sequenceRepo: new SequenceRepo(pool),
    groupRepo: new GroupRepo(pool),
    accountRepo: new AccountRepo(pool),
    outboxRepo: new OutboxRepo(pool),
    log,
  };
}

const STEPS: SequenceStepDef[] = [
  { text: 'Hello {name}', delaySeconds: 0, accountRole: 'admin' },
  { text: 'Step 2 {city}', delaySeconds: 1, accountRole: 'member' },
];

describe('sequence-runner 预检与变量', () => {
  it('preflight: 占位符不可解析 → 返回 stepIndex + key', () => {
    const err = preflight(STEPS, { name: 'Alice' }, {});
    expect(err).toEqual({ stepIndex: 1, key: 'city' });
  });

  it('preflight: 全部可解析 → null', () => {
    const err = preflight(STEPS, { name: 'Alice', city: 'BJ' }, {});
    expect(err).toBeNull();
  });

  it('computeStickyVars: stepVars 黏性生效', () => {
    const steps: SequenceStepDef[] = [
      { text: '{a}', delaySeconds: 0, accountRole: 'admin' },
      { text: '{a}', delaySeconds: 0, accountRole: 'admin' },
      { text: '{a}', delaySeconds: 0, accountRole: 'admin' },
    ];
    const result = computeStickyVars(steps, { a: 'x' }, { '1': { a: 'y' } });
    expect(result[0]!.resolvedVars['a']).toBe('x');
    expect(result[1]!.resolvedVars['a']).toBe('y');
    expect(result[2]!.resolvedVars['a']).toBe('y'); // 黏性
    expect(result[0]!.varSources['a']).toBe('default');
    expect(result[1]!.varSources['a']).toBe('step:1');
    expect(result[2]!.varSources['a']).toBe('step:1');
  });

  it('computeStickyVars: stepVars 空字符串不改值', () => {
    const steps: SequenceStepDef[] = [
      { text: '{a}', delaySeconds: 0, accountRole: 'admin' },
      { text: '{a}', delaySeconds: 0, accountRole: 'admin' },
    ];
    const result = computeStickyVars(steps, { a: 'x' }, { '0': { a: '' } });
    expect(result[0]!.resolvedVars['a']).toBe('x');
    expect(result[1]!.resolvedVars['a']).toBe('x');
  });

  it('resolveText: 替换占位符', () => {
    expect(resolveText('Hi {name}', { name: 'Bob' })).toBe('Hi Bob');
    expect(resolveText('{a}-{b}', { a: '1', b: '2' })).toBe('1-2');
  });
});

describe('sequence-runner 账号选择', () => {
  it('admin: 优先 admin 角色', () => {
    const members = [
      { groupId: 'g', accountId: 'uuid-creator', role: 'creator', joinedAt: new Date() } as never,
      { groupId: 'g', accountId: 'uuid-admin', role: 'admin', joinedAt: new Date() } as never,
    ];
    const accounts = [
      { id: 'uuid-creator', accountId: 'acct-1', status: 'online', rateLimitedUntil: null },
      { id: 'uuid-admin', accountId: 'acct-2', status: 'online', rateLimitedUntil: null },
    ];
    const sel = selectAccount(members, accounts, 'admin');
    expect(sel.kind).toBe('found');
    expect(sel.kind === 'found' && sel.accountId).toBe('uuid-admin');
  });

  it('member: 按 accountId 字典序取第一个 online', () => {
    const members = [
      { groupId: 'g', accountId: 'uuid-b', role: 'member', joinedAt: new Date() } as never,
      { groupId: 'g', accountId: 'uuid-a', role: 'member', joinedAt: new Date() } as never,
    ];
    const accounts = [
      { id: 'uuid-a', accountId: 'acct-a', status: 'online', rateLimitedUntil: null },
      { id: 'uuid-b', accountId: 'acct-b', status: 'online', rateLimitedUntil: null },
    ];
    const sel = selectAccount(members, accounts, 'member');
    expect(sel.kind).toBe('found');
    expect(sel.kind === 'found' && sel.accountId).toBe('uuid-a');
  });

  it('无匹配账号 → none', () => {
    const members = [{ groupId: 'g', accountId: 'uuid-x', role: 'member', joinedAt: new Date() } as never];
    const accounts = [{ id: 'uuid-x', accountId: 'acct-x', status: 'disconnected', rateLimitedUntil: null }];
    const sel = selectAccount(members, accounts, 'member');
    expect(sel.kind).toBe('none');
  });

  it('rate_limited → rate_limited（顺延）', () => {
    const members = [{ groupId: 'g', accountId: 'uuid-x', role: 'member', joinedAt: new Date() } as never];
    const accounts = [{ id: 'uuid-x', accountId: 'acct-x', status: 'rate_limited', rateLimitedUntil: null }];
    const sel = selectAccount(members, accounts, 'member');
    expect(sel.kind).toBe('rate_limited');
  });
});

describe('sequence-runner 启动与执行', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('startSequenceRun: 创建 run + steps，第 1 步排期', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const deps = makeDeps();
    const seq = await deps.sequenceRepo.createSequence(pool, 'test', STEPS);

    const runId = await startSequenceRun(deps, groupId, seq.id, { name: 'Alice', city: 'BJ' }, {});

    const run = await deps.sequenceRepo.getRun(pool, runId);
    expect(run?.status).toBe('running');
    const steps = await deps.sequenceRepo.getSteps(pool, runId);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe('pending');
    expect(steps[0]!.scheduledAt).not.toBeNull();
    expect(steps[1]!.status).toBe('pending');
    expect(steps[1]!.scheduledAt).toBeNull();
  });

  it('startSequenceRun: 占位符不可解析 → 抛错且不留运行记录', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const deps = makeDeps();
    const seq = await deps.sequenceRepo.createSequence(pool, 'test', STEPS);

    await expect(startSequenceRun(deps, groupId, seq.id, { name: 'Alice' }, {})).rejects.toThrow(
      'UNRESOLVED_PLACEHOLDER',
    );
    // 不留运行记录
    const runs = await deps.sequenceRepo.listRunsByGroup(pool, groupId);
    expect(runs).toHaveLength(0);
  });

  it('startSequenceRun: 同群已有 running → 抛 SEQUENCE_ALREADY_RUNNING', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const deps = makeDeps();
    const seq = await deps.sequenceRepo.createSequence(pool, 'test', STEPS);

    await startSequenceRun(deps, groupId, seq.id, { name: 'Alice', city: 'BJ' }, {});
    await expect(startSequenceRun(deps, groupId, seq.id, { name: 'Alice', city: 'BJ' }, {})).rejects.toThrow(
      'SEQUENCE_ALREADY_RUNNING',
    );
  });

  it('executeDueStep: 有 online 账号 → 入队 outbox + 标记 accepted', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    // 把成员设为 admin 角色
    await pool.query(`UPDATE group_members SET role='admin' WHERE group_id=$1`, [groupId]);

    const deps = makeDeps();
    const steps: SequenceStepDef[] = [
      { text: 'Hello {name}', delaySeconds: 0, accountRole: 'admin' },
    ];
    const seq = await deps.sequenceRepo.createSequence(pool, 'test', steps);
    const runId = await startSequenceRun(deps, groupId, seq.id, { name: 'Alice' }, {});

    await executeDueStep(deps, runId, 0);

    const stepRows = await deps.sequenceRepo.getSteps(pool, runId);
    expect(stepRows[0]!.status).toBe('accepted');
    expect(stepRows[0]!.outboxId).not.toBeNull();
    expect(stepRows[0]!.resolvedVars).toEqual({ name: 'Alice' });
    expect(stepRows[0]!.varSources).toEqual({ name: 'default' });

    // outbox 已入队
    const outbox = await deps.outboxRepo.findById(stepRows[0]!.outboxId!);
    expect(outbox?.text).toBe('Hello Alice');
    expect(outbox?.origin).toBe('sequence');
  });

  it('executeDueStep: 无可用账号 → skipped 并排下一步', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    // 账号设为 disconnected（非 online 且非 rate_limited）
    await pool.query(`UPDATE accounts SET status='disconnected' WHERE account_id='acct-1'`);

    const deps = makeDeps();
    const steps: SequenceStepDef[] = [
      { text: 'Step 1', delaySeconds: 0, accountRole: 'member' },
      { text: 'Step 2', delaySeconds: 0, accountRole: 'member' },
    ];
    const seq = await deps.sequenceRepo.createSequence(pool, 'test', steps);
    const runId = await startSequenceRun(deps, groupId, seq.id, {}, {});

    await executeDueStep(deps, runId, 0);

    const stepRows = await deps.sequenceRepo.getSteps(pool, runId);
    expect(stepRows[0]!.status).toBe('skipped');
    // 下一步被排期
    expect(stepRows[1]!.scheduledAt).not.toBeNull();
  });

  it('executeDueStep: rate_limited → 顺延（不更新状态）', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    await pool.query(`UPDATE accounts SET status='rate_limited' WHERE account_id='acct-1'`);

    const deps = makeDeps();
    const steps: SequenceStepDef[] = [
      { text: 'Step 1', delaySeconds: 0, accountRole: 'member' },
    ];
    const seq = await deps.sequenceRepo.createSequence(pool, 'test', steps);
    const runId = await startSequenceRun(deps, groupId, seq.id, {}, {});

    await executeDueStep(deps, runId, 0);

    const stepRows = await deps.sequenceRepo.getSteps(pool, runId);
    // 仍是 pending，等待限流结束
    expect(stepRows[0]!.status).toBe('pending');
  });

  it('§2.3 事件：启动 → running/0；跳过中间步 → running/1；最后一步跳过 → finished', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    // member 角色无 online 账号 → 每一步都会 skipped
    await pool.query(`UPDATE accounts SET status='disconnected' WHERE account_id='acct-1'`);

    const deps = makeDeps();
    const steps: SequenceStepDef[] = [
      { text: 'Step 1', delaySeconds: 0, accountRole: 'member' },
      { text: 'Step 2', delaySeconds: 0, accountRole: 'member' },
    ];
    const seq = await deps.sequenceRepo.createSequence(pool, 'test', steps);
    const runId = await startSequenceRun(deps, groupId, seq.id, {}, {});

    // 启动事件
    let events = await pool.query<{ payload: { status: string; currentStepIndex: number } }>(
      `SELECT payload FROM web_events
       WHERE type = 'sequence_run' AND payload->>'runId' = $1
       ORDER BY seq ASC`,
      [runId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toMatchObject({ status: 'running', currentStepIndex: 0 });

    await executeDueStep(deps, runId, 0);
    await executeDueStep(deps, runId, 1);

    events = await pool.query<{ payload: { status: string; currentStepIndex: number } }>(
      `SELECT payload FROM web_events
       WHERE type = 'sequence_run' AND payload->>'runId' = $1
       ORDER BY seq ASC`,
      [runId],
    );
    // 启动 + 推进到第 2 步 + finished，共 3 条
    expect(events.rows.map((r) => [r.payload.status, r.payload.currentStepIndex])).toEqual([
      ['running', 0],
      ['running', 1],
      ['finished', 1],
    ]);
  });
});
