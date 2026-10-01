/**
 * 终态原子后果测试（规划 02 §7 + 任务 2.12）：
 *  - 完整 5 步后果全部落库
 *  - 重复进入同一终态幂等（不重复事件）
 *  - 四种来源（send_error / gateway_event / operator / agent）结果逐字段一致
 *  - 第 4 步失败时整个事务回滚（触发器注入失败）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { markTerminal, type TerminalSource } from '../../src/services/account-terminal.js';
import {
  armStepUpdateFailure,
  pool,
  queryMany,
  queryOne,
  resetDb,
  seedTerminalScenario,
  type TerminalFixture,
} from '../helpers/db.js';

const ALL_SOURCES: readonly TerminalSource[] = [
  'send_error',
  'gateway_event',
  'operator',
  'agent',
];

/** 取某账号终态后果的完整"快照"，用于逐字段比对。 */
async function snapshot(accountId: string, accountUuid: string): Promise<{
  status: string;
  memberCount: string;
  outbox: Array<{ delivery_status: string; fail_code: string | null }>;
  steps: Array<{ status: string }>;
  events: Array<{ type: string; source: string | null; status: string | null }>;
}> {
  const statusRow = await queryOne<{ status: string }>(
    'SELECT status FROM accounts WHERE account_id = $1',
    [accountId],
  );
  const memberRow = await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM group_members WHERE account_id = $1',
    [accountUuid],
  );
  const outbox = await queryMany<{ delivery_status: string; fail_code: string | null }>(
    `SELECT delivery_status, fail_code FROM outbox_messages
     WHERE account_id = $1 ORDER BY client_msg_id`,
    [accountUuid],
  );
  const steps = await queryMany<{ status: string }>(
    `SELECT ss.status FROM sequence_steps ss
       JOIN outbox_messages om ON om.id = ss.outbox_id
      WHERE om.account_id = $1`,
    [accountUuid],
  );
  const events = await queryMany<{ type: string; source: string | null; status: string | null }>(
    `SELECT type,
            payload->>'source' AS source,
            payload->>'status' AS status
       FROM web_events
      WHERE payload->>'accountId' = $1
      ORDER BY seq`,
    [accountId],
  );
  return {
    status: statusRow!.status,
    memberCount: memberRow!.count,
    outbox,
    steps,
    events,
  };
}

async function accountUuidOf(accountId: string): Promise<string> {
  const row = await queryOne<{ id: string }>('SELECT id FROM accounts WHERE account_id = $1', [
    accountId,
  ]);
  return row!.id;
}

describe('markTerminal 终态原子后果', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('完整后果：移出 3 群 + 2 条 cancelled(ACCOUNT_TERMINAL) + 1 步 skipped + 1 条事件', async () => {
    const fx: TerminalFixture = await seedTerminalScenario('acct-1');

    const result = await markTerminal(pool, 'acct-1', 'suspended', 'operator');
    expect(result).toEqual({
      executed: true,
      removedFromGroups: 3,
      cancelledMessages: 2,
      skippedSteps: 1,
    });

    const snap = await snapshot('acct-1', await accountUuidOf('acct-1'));
    expect(snap.status).toBe('suspended');
    expect(snap.memberCount).toBe('0');
    expect(snap.outbox).toEqual([
      { delivery_status: 'cancelled', fail_code: 'ACCOUNT_TERMINAL' },
      { delivery_status: 'cancelled', fail_code: 'ACCOUNT_TERMINAL' },
    ]);
    expect(snap.steps).toEqual([{ status: 'skipped' }]);
    expect(snap.events).toEqual([{ type: 'account_terminal', source: 'operator', status: 'suspended' }]);
  });

  it('重复进入同一终态：幂等，executed=false，不重复事件、不重复扣减', async () => {
    await seedTerminalScenario('acct-1');

    const first = await markTerminal(pool, 'acct-1', 'session_expired', 'send_error');
    expect(first.executed).toBe(true);

    const second = await markTerminal(pool, 'acct-1', 'session_expired', 'operator');
    expect(second).toEqual({
      executed: false,
      removedFromGroups: 0,
      cancelledMessages: 0,
      skippedSteps: 0,
    });

    // 只有第一次的事件；且来源以第一次为准（send_error），不被第二次覆盖
    const events = await queryMany<{ source: string | null }>(
      `SELECT payload->>'source' AS source FROM web_events
       WHERE payload->>'accountId' = 'acct-1' ORDER BY seq`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe('send_error');
  });

  it('已处于一个终态后再标记另一个终态：抛错', async () => {
    await seedTerminalScenario('acct-1');
    await markTerminal(pool, 'acct-1', 'suspended', 'operator');
    await expect(
      markTerminal(pool, 'acct-1', 'session_expired', 'operator'),
    ).rejects.toThrow(/suspended.*session_expired/);
  });

  it('账号不存在：抛错', async () => {
    await expect(
      markTerminal(pool, 'acct-nope', 'suspended', 'operator'),
    ).rejects.toThrow(/不存在/);
  });

  it('四种来源产生的 DB 结果逐字段一致（仅 payload.source 随来源不同）', async () => {
    const accounts = ['acct-1', 'acct-2', 'acct-3', 'acct-4'] as const;
    const snapshots: Array<Record<string, unknown>> = [];

    for (let i = 0; i < 4; i++) {
      const accountId = accounts[i]!;
      const source = ALL_SOURCES[i]!;
      await seedTerminalScenario(accountId);
      await markTerminal(pool, accountId, 'suspended', source);

      const snap = await snapshot(accountId, await accountUuidOf(accountId));
      // 把"随来源变化"的字段归一化，其余字段必须完全一致
      const normalized = {
        ...snap,
        events: snap.events.map((e) => ({ ...e, source: '<source>' })),
      };
      snapshots.push(normalized as unknown as Record<string, unknown>);
    }

    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]).toEqual(snapshots[0]);
    }
    // 同时确认每条事件的 source 确实被正确写入（各自不同）
    for (let i = 0; i < 4; i++) {
      const events = await queryMany<{ source: string | null }>(
        `SELECT payload->>'source' AS source FROM web_events
         WHERE payload->>'accountId' = $1`,
        [accounts[i]],
      );
      expect(events[0]?.source).toBe(ALL_SOURCES[i]);
    }
  });

  it('原子性：第 4 步（sequence_steps 更新）注入失败 → 全部回滚，库中无任何部分后果', async () => {
    await seedTerminalScenario('acct-1');
    const accountUuid = await accountUuidOf('acct-1');
    const dropTrigger = await armStepUpdateFailure();

    try {
      await expect(
        markTerminal(pool, 'acct-1', 'suspended', 'operator'),
      ).rejects.toThrow(/injected failure/);
    } finally {
      await dropTrigger();
    }

    // 事务整体回滚：状态、成员、消息、步骤、事件全部保持操作前
    const snap = await snapshot('acct-1', accountUuid);
    expect(snap.status).toBe('online');
    expect(snap.memberCount).toBe('3');
    expect(snap.outbox).toEqual([
      { delivery_status: 'queued', fail_code: null },
      { delivery_status: 'queued', fail_code: null },
    ]);
    expect(snap.steps).toEqual([{ status: 'pending' }]);
    expect(snap.events).toEqual([]);
  });
});
