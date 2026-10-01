/**
 * GET /api/jobs/:jobId 集成测试（切片 4 批次 1，规划 04 任务 4.7 / 契约 §5）。
 *
 * 覆盖：
 *  - 200：返回 { status, errors }（受理后尚未执行 → running / []）
 *  - 404 NOT_FOUND：未知 UUID
 *  - 400 VALIDATION_ERROR：非 UUID
 *  - 401 无 token
 *
 * 运行方式：buildServer + fastify.inject，不监听端口。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/auth/tokens.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { pool, resetDb } from '../helpers/db.js';

let app: FastifyInstance;
let adminToken: string;

beforeAll(async () => {
  const config: AppConfig = loadConfig({
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test',
    GATEWAY_URL: 'http://127.0.0.1:1',
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
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
});

function getJob(jobId: string, token: string | null = adminToken) {
  return app.inject({
    method: 'GET',
    url: `/api/jobs/${jobId}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

/** 经 POST /api/groups 受理一个 job，返回 jobId。 */
async function createJobViaApi(): Promise<string> {
  for (const id of ['acct-1', 'acct-2']) {
    await pool.query(`UPDATE accounts SET status = 'online' WHERE account_id = $1`, [id]);
  }
  const res = await app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { creatorAccountId: 'acct-1', memberAccountIds: ['acct-2'] },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { jobId: string }).jobId;
}

describe('GET /api/jobs/:jobId', () => {
  it('存在的 job → 200 { status: running, errors: [] }', async () => {
    const jobId = await createJobViaApi();

    const res = await getJob(jobId);

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      kind: string;
      status: string;
      errors: unknown[];
    };
    expect(body.id).toBe(jobId);
    expect(body.kind).toBe('create_group');
    expect(body.status).toBe('running');
    expect(body.errors).toEqual([]);
  });

  it('未知 UUID → 404 NOT_FOUND', async () => {
    const res = await getJob(randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('非 UUID → 400 VALIDATION_ERROR', async () => {
    const res = await getJob('not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('无 token → 401 UNAUTHORIZED', async () => {
    const res = await getJob(randomUUID(), null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});
