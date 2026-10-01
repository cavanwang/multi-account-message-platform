/**
 * 数据库测试工具：连接池、每用例重置、终态场景 fixture。
 *
 * 所有测试共享 app_test 库（由 global-setup 建库并迁移）；
 * beforeEach 调 resetDb() 把业务表清空到与"全新迁移后"等价的状态。
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll } from 'vitest';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test';

/** 测试共用连接池（globalSetup 之后库一定存在）。 */
export const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 10 });

// 每个测试文件结束后关闭本文件模块持有的连接池，避免 vitest 因存活句柄挂起
afterAll(async () => {
  await pool.end();
});

/**
 * 清空全部业务表（不含 schema_migrations），序列号归零，重插 4 个 seed 账号。
 * 每个用例前调用，保证用例之间完全隔离。
 */
export async function resetDb(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      agent_run_pending_messages,
      agent_tool_calls,
      agent_steps,
      agent_run_messages,
      agent_runs,
      group_job_members,
      jobs,
      pending_reconciliations,
      events_inbox,
      events_cursor,
      messages,
      web_events,
      sequence_steps,
      sequence_runs,
      outbox_messages,
      group_members,
      groups,
      accounts,
      refresh_sessions
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`
    INSERT INTO accounts (account_id, status, version)
    VALUES ('acct-1','idle',1), ('acct-2','idle',1), ('acct-3','idle',1), ('acct-4','idle',1)
  `);
  // events_cursor / ws_push_cursor 是单行表，TRUNCATE 后恢复初始行（与迁移 0006/0007 一致）。
  // 多测试文件并发跑 resetDb 时 TRUNCATE→INSERT 存在竞态窗口，用 ON CONFLICT 幂等重置。
  await pool.query(
    `INSERT INTO events_cursor (id, last_seen_event_id) VALUES (1, 0)
     ON CONFLICT (id) DO UPDATE SET last_seen_event_id = 0`,
  );
  await pool.query(
    `INSERT INTO ws_push_cursor (id, last_pushed_seq) VALUES (1, 0)
     ON CONFLICT (id) DO UPDATE SET last_pushed_seq = 0`,
  );
}

/** 查询单行（无结果返回 undefined）。 */
export async function queryOne<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const { rows } = await pool.query<T>(sql, params);
  return rows[0];
}

/** 查询多行。 */
export async function queryMany<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

export interface TerminalFixture {
  readonly accountId: string;
  readonly groupIds: string[];
  readonly queuedClientMsgIds: string[];
  readonly runId: string;
  readonly pendingStepIndex: number;
}

/**
 * 构造规划 §7 要求的终态场景：
 *   账号在 3 个群里（每群 1 条成员记录）+ 2 条 queued 出站消息
 *   + 1 个 running 序列，其中 1 个 pending 步骤挂在第 1 条消息上。
 */
export async function seedTerminalScenario(accountId = 'acct-1'): Promise<TerminalFixture> {
  const { rows: accountRows } = await pool.query<{ id: string }>(
    'UPDATE accounts SET status=$1 WHERE account_id=$2 RETURNING id',
    ['online', accountId],
  );
  const accountUuid = accountRows[0]?.id;
  if (accountUuid === undefined) throw new Error(`seed 账号 ${accountId} 不存在`);

  const groupIds: string[] = [];
  const queuedClientMsgIds: string[] = [];

  for (let i = 0; i < 3; i++) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO groups (gateway_group_id, creator_account_id)
       VALUES ($1, $2) RETURNING id`,
      [`grp_test_${accountId}_${i}_${randomUUID()}`, accountUuid],
    );
    const groupId = rows[0]?.id;
    if (groupId === undefined) throw new Error('建群失败');
    groupIds.push(groupId);

    await pool.query(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [groupId, accountUuid, `pu_${accountId}_${i}`],
    );
  }

  // 2 条 queued 出站（分属前两个群）
  for (let i = 0; i < 2; i++) {
    const clientMsgId = randomUUID();
    queuedClientMsgIds.push(clientMsgId);
    await pool.query(
      `INSERT INTO outbox_messages (group_id, account_id, client_msg_id, text, delivery_status, origin)
       VALUES ($1, $2, $3, 'test message', 'queued', 'api')`,
      [groupIds[i], accountUuid, clientMsgId],
    );
  }

  // 1 个 running 序列（挂在第 1 个群）
  const { rows: runRows } = await pool.query<{ id: string }>(
    `INSERT INTO sequence_runs (group_id, status) VALUES ($1, 'running') RETURNING id`,
    [groupIds[0]],
  );
  const runId = runRows[0]?.id;
  if (runId === undefined) throw new Error('建序列失败');

  // 1 个 pending 步骤关联第 1 条 outbox
  const { rows: outboxRows } = await pool.query<{ id: string }>(
    'SELECT id FROM outbox_messages WHERE client_msg_id = $1',
    [queuedClientMsgIds[0]],
  );
  const firstOutboxId = outboxRows[0]?.id;
  if (firstOutboxId === undefined) throw new Error('outbox 查询失败');

  await pool.query(
    `INSERT INTO sequence_steps (run_id, step_index, status, outbox_id)
     VALUES ($1, 0, 'pending', $2)`,
    [runId, firstOutboxId],
  );

  return { accountId, groupIds, queuedClientMsgIds, runId, pendingStepIndex: 0 };
}

/**
 * 安装"让 sequence_steps 的 UPDATE 必失败"的触发器，用于验证终态事务的原子回滚。
 * 返回卸载函数（测试 finally 中务必调用）。
 */
export async function armStepUpdateFailure(ruleName = 'trg_fail_steps_update'): Promise<() => Promise<void>> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_steps_update() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'injected failure in sequence_steps update'
        USING ERRCODE = 'P0001';
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`CREATE TRIGGER ${ruleName} BEFORE UPDATE ON sequence_steps
    FOR EACH ROW EXECUTE FUNCTION fail_steps_update()`);

  return async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${ruleName} ON sequence_steps`);
    await pool.query('DROP FUNCTION IF EXISTS fail_steps_update()');
  };
}

/**
 * 在共享池上跑一个事务：BEGIN → fn → COMMIT，异常则 ROLLBACK。
 * claimQueued 等必须在事务内调用的 repo 方法用它包裹。
 */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 建群并把账号置为 online 加入（成员 role=member，platformUserId 自动生成）。
 * 返回两侧 UUID 与网关群 ID。
 */
export async function seedGroupWithMember(
  accountId = 'acct-1',
): Promise<{ accountUuid: string; groupId: string; gatewayGroupId: string }> {
  const { rows: accountRows } = await pool.query<{ id: string }>(
    `UPDATE accounts SET status='online', platform_user_id='pu_' || account_id
     WHERE account_id=$1 RETURNING id`,
    [accountId],
  );
  const accountUuid = accountRows[0]?.id;
  if (accountUuid === undefined) throw new Error(`seed 账号 ${accountId} 不存在`);

  const gatewayGroupId = `grp_${randomUUID()}`;
  const { rows: groupRows } = await pool.query<{ id: string }>(
    `INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ($1, $2) RETURNING id`,
    [gatewayGroupId, accountUuid],
  );
  const groupId = groupRows[0]?.id;
  if (groupId === undefined) throw new Error('建群失败');

  await pool.query(
    `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
     VALUES ($1, $2, $3, 'member')`,
    [groupId, accountUuid, `pu_${accountId}`],
  );

  return { accountUuid, groupId, gatewayGroupId };
}

export interface OutboxSeedOptions {
  readonly status?: 'queued' | 'accepted' | 'sent' | 'failed' | 'unknown' | 'cancelled';
  /** failed/cancelled 未显式给 failCode 时自动填 'TEST_FAIL'（DB CHECK 约束要求）。 */
  readonly failCode?: string;
  readonly generation?: number;
  readonly createdAt?: Date;
  readonly origin?: 'api' | 'agent' | 'sequence';
}

/** 直接插一行 outbox_messages（绕过 repo，用于构造测试前置数据）。 */
export async function insertOutbox(
  groupId: string,
  accountUuid: string,
  opts: OutboxSeedOptions = {},
): Promise<{ id: string; clientMsgId: string }> {
  const status = opts.status ?? 'queued';
  const failCode =
    opts.failCode ?? (status === 'failed' || status === 'cancelled' ? 'TEST_FAIL' : null);
  const clientMsgId = randomUUID();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO outbox_messages
       (group_id, account_id, client_msg_id, text, delivery_status, fail_code, origin, generation, created_at)
     VALUES ($1, $2, $3, 'test message', $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
     RETURNING id`,
    [
      groupId,
      accountUuid,
      clientMsgId,
      status,
      failCode,
      opts.origin ?? 'api',
      opts.generation ?? 0,
      opts.createdAt ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('插入 outbox 失败');
  return { id, clientMsgId };
}
