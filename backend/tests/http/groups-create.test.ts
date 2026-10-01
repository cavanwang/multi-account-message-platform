/**
 * POST /api/groups 集成测试（切片 4 批次 1，规划 04 任务 4.2 / 契约 §5）。
 *
 * 覆盖：
 *  - 202 受理：jobs 行（running / create_group / payload 正确）+ group_job_members 名单落库
 *  - 400 VALIDATION_ERROR：缺 creatorAccountId / memberAccountIds 空 / 非数组 / 含群主 / 重复成员
 *  - 422 ACCOUNT_NOT_ONLINE：群主离线 / 成员离线 / 账号不存在
 *  - 401 无 token；403 viewer 写操作
 *  - 拒绝场景不落库（jobs 保持空表）
 *
 * 运行方式：buildServer + fastify.inject，不监听端口；本端点不触网关（GATEWAY_URL 占位）。
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/auth/tokens.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { pool, queryMany, queryOne, resetDb } from '../helpers/db.js';

let app: FastifyInstance;
let adminToken: string;
let viewerToken: string;

beforeAll(async () => {
  const config: AppConfig = loadConfig({
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test',
    GATEWAY_URL: 'http://127.0.0.1:1', // 受理阶段不触网关，占位即可
    AGENT_URL: 'http://127.0.0.1:1',
    JWT_SECRET: 'test-secret-test-secret',
    LOG_LEVEL: 'fatal',
  });
  app = await buildServer({ config, pool });
  await app.ready();
  adminToken = await signAccessToken(config, {
    userId: 'user-admin',
    username: 'admin',
    role: 'admin',
  });
  viewerToken = await signAccessToken(config, {
    userId: 'user-viewer',
    username: 'viewer',
    role: 'viewer',
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
});

/** 便捷发请求：默认带 admin token。 */
function createGroup(body: unknown, token: string | null = adminToken) {
  return app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
}

/** 把 seed 账号直接置为指定状态（构造前置条件）。 */
async function setAccountStatus(accountId: string, status: string): Promise<void> {
  await pool.query('UPDATE accounts SET status = $2 WHERE account_id = $1', [accountId, status]);
}

// 用 type 别名而非 interface：对象字面量类型带隐式索引签名，
// 才能满足 queryOne/queryMany 的 Record<string, unknown> 约束
type JobDbRow = {
  id: string;
  kind: string;
  status: string;
  payload: { creatorAccountId: string; memberAccountIds: string[] };
  errors: unknown[];
};

type JobMemberDbRow = {
  job_id: string;
  account_id: string;
  join_requested_at: Date | null;
  joined_at: Date | null;
  promote_calls: number;
};

/** 把 acct-1/2/3 全部置为 online（建群受理的常规前置）。 */
async function onlineThree(): Promise<void> {
  for (const id of ['acct-1', 'acct-2', 'acct-3']) {
    await setAccountStatus(id, 'online');
  }
}

describe('POST /api/groups', () => {
  it('全部 online → 202，job 与成员名单事务落库', async () => {
    await onlineThree();

    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-2', 'acct-3'],
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // jobs 行：running / create_group / errors=[] / payload 与请求一致
    const job = await queryOne<JobDbRow>('SELECT * FROM jobs WHERE id = $1', [jobId]);
    expect(job).toBeDefined();
    expect(job!.kind).toBe('create_group');
    expect(job!.status).toBe('running');
    expect(job!.errors).toEqual([]);
    expect(job!.payload).toEqual({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-2', 'acct-3'],
    });

    // group_job_members：两个成员各一行，初始 join_requested_at/joined_at NULL、promote_calls=0
    const members = await queryMany<JobMemberDbRow>(
      `SELECT m.* FROM group_job_members m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.job_id = $1 ORDER BY a.account_id`,
      [jobId],
    );
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m.join_requested_at).toBeNull();
      expect(m.joined_at).toBeNull();
      expect(m.promote_calls).toBe(0);
    }
  });

  it('memberAccountIds 为空数组 → 400 VALIDATION_ERROR', async () => {
    await onlineThree();
    const res = await createGroup({ creatorAccountId: 'acct-1', memberAccountIds: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('memberAccountIds 非数组 → 400 VALIDATION_ERROR', async () => {
    await onlineThree();
    const res = await createGroup({ creatorAccountId: 'acct-1', memberAccountIds: 'acct-2' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('缺 creatorAccountId → 400 VALIDATION_ERROR', async () => {
    await onlineThree();
    const res = await createGroup({ memberAccountIds: ['acct-2'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('memberAccountIds 含群主 → 400 VALIDATION_ERROR', async () => {
    await onlineThree();
    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-1', 'acct-2'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('memberAccountIds 有重复成员 → 400 VALIDATION_ERROR', async () => {
    await onlineThree();
    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-2', 'acct-2'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('群主离线（idle）→ 422 ACCOUNT_NOT_ONLINE，不落库', async () => {
    await setAccountStatus('acct-2', 'online'); // acct-1 保持 idle

    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-2'],
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('ACCOUNT_NOT_ONLINE');
    expect(body.error.accountId).toBe('acct-1');
    expect(body.error.status).toBe('idle');

    const jobs = await queryMany<JobDbRow>('SELECT * FROM jobs');
    expect(jobs).toHaveLength(0);
  });

  it('成员离线（idle）→ 422 ACCOUNT_NOT_ONLINE，不落库', async () => {
    await setAccountStatus('acct-1', 'online'); // acct-2 保持 idle

    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-2'],
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('ACCOUNT_NOT_ONLINE');
    expect(body.error.accountId).toBe('acct-2');

    const jobs = await queryMany<JobDbRow>('SELECT * FROM jobs');
    expect(jobs).toHaveLength(0);
  });

  it('账号不存在 → 422 ACCOUNT_NOT_ONLINE（契约只定义 400/422）', async () => {
    await onlineThree();

    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-2', 'acct-ghost'],
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('ACCOUNT_NOT_ONLINE');
    expect(body.error.accountId).toBe('acct-ghost');
    expect(body.error.status).toBeNull();
  });

  it('rate_limited 不算 online → 422 ACCOUNT_NOT_ONLINE', async () => {
    await setAccountStatus('acct-1', 'online');
    await setAccountStatus('acct-2', 'rate_limited');

    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-2'],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_ONLINE');
  });

  it('memberAccountIds 超过上限（>100）→ 400 VALIDATION_ERROR', async () => {
    await onlineThree();
    const members = Array.from({ length: 101 }, (_, i) => `acct-x${i}`);
    const res = await createGroup({ creatorAccountId: 'acct-1', memberAccountIds: members });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('成员 ID 带空白 → 400 VALIDATION_ERROR（不误报为 422）', async () => {
    await onlineThree();
    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: [' acct-2 '],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('多个成员同时离线时，按请求顺序报第一个（报错顺序稳定）', async () => {
    await setAccountStatus('acct-1', 'online'); // acct-3/acct-4 保持 idle

    const res = await createGroup({
      creatorAccountId: 'acct-1',
      memberAccountIds: ['acct-3', 'acct-4'],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.accountId).toBe('acct-3');
  });

  it('无 token → 401 UNAUTHORIZED', async () => {
    const res = await createGroup(
      { creatorAccountId: 'acct-1', memberAccountIds: ['acct-2'] },
      null,
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('viewer 写操作 → 403 FORBIDDEN', async () => {
    await onlineThree();
    const res = await createGroup(
      { creatorAccountId: 'acct-1', memberAccountIds: ['acct-2'] },
      viewerToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
