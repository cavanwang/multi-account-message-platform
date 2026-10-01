/**
 * POST /api/groups/:id/send 集成测试（规划 03 任务 3.3 / 契约 §3）。
 *
 * 覆盖：
 *  - 202 正常入队：DB 落 queued 行、clientMsgId 一致、generation=0（INV-1 先落库）
 *  - 账号状态门禁：idle / disconnected / suspended → 409 ACCOUNT_UNAVAILABLE
 *  - rate_limited 特例：照常 202，行保持 queued（到期后由 worker 按序发出）
 *  - 成员门禁：不在群 → 409 ACCOUNT_NOT_IN_GROUP（群不存在同样归此类）
 *  - 参数校验：缺 accountId / 空 text / 非法 UUID → 400 VALIDATION_ERROR
 *  - 拒绝场景不入队（outbox 保持空表）
 *
 * 运行方式：buildServer + fastify.inject，不监听端口；日志级别 fatal 保持输出干净。
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/auth/tokens.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { pool, queryMany, queryOne, resetDb, seedGroupWithMember } from '../helpers/db.js';

let app: FastifyInstance;
let adminToken: string;
let config: AppConfig;

beforeAll(async () => {
  config = loadConfig({
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test',
    GATEWAY_URL: 'http://127.0.0.1:1', // send 不触网关，占位即可
    AGENT_URL: 'http://127.0.0.1:1',
    JWT_SECRET: 'test-secret-test-secret',
    LOG_LEVEL: 'fatal',
  });
  app = await buildServer({ config, pool });
  await app.ready();
  adminToken = await signAccessToken(config, {
    userId: 'user-test',
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

/** 便捷发请求：默认带 admin token。 */
function send(groupId: string, body: unknown, token: string | null = adminToken) {
  return app.inject({
    method: 'POST',
    url: `/api/groups/${groupId}/send`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
}

/** 把 seed 账号直接置为指定状态（绕过 service，构造前置条件）。 */
async function setAccountStatus(accountId: string, status: string): Promise<void> {
  await pool.query(
    `UPDATE accounts SET status = $2,
       rate_limited_until = CASE WHEN $2 = 'rate_limited' THEN now() + interval '60 seconds' ELSE NULL END
     WHERE account_id = $1`,
    [accountId, status],
  );
}

// 用 type 别名而非 interface：对象字面量类型带隐式索引签名，
// 才能满足 queryOne/queryMany 的 Record<string, unknown> 约束
type OutboxDbRow = {
  client_msg_id: string;
  delivery_status: string;
  text: string;
  origin: string;
  generation: number;
  group_id: string;
  account_id: string;
};

describe('POST /api/groups/:id/send', () => {
  it('online 账号在群中 → 202，事务落 queued 行（INV-1 先落库）', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');

    const res = await send(groupId, { accountId: 'acct-1', text: 'hello world' });

    expect(res.statusCode).toBe(202);
    const { clientMsgId } = res.json() as { clientMsgId: string };
    expect(clientMsgId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const row = await queryOne<OutboxDbRow>(
      'SELECT * FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row).toBeDefined();
    expect(row!.delivery_status).toBe('queued');
    expect(row!.text).toBe('hello world');
    expect(row!.origin).toBe('api');
    expect(row!.generation).toBe(0); // 尚未向网关发出过 HTTP
    expect(row!.group_id).toBe(groupId);
    expect(row!.account_id).toBe(accountUuid);
  });

  it('rate_limited 账号 → 照常 202，行保持 queued（契约特例，不算失败）', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    await setAccountStatus('acct-1', 'rate_limited');

    const res = await send(groupId, { accountId: 'acct-1', text: 'deferred' });

    expect(res.statusCode).toBe(202);
    const { clientMsgId } = res.json() as { clientMsgId: string };
    const row = await queryOne<OutboxDbRow>(
      'SELECT * FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row!.delivery_status).toBe('queued');
  });

  it.each(['idle', 'disconnected', 'suspended', 'session_expired'])(
    '账号状态 %s → 409 ACCOUNT_UNAVAILABLE，且不入队',
    async (status) => {
      const { groupId } = await seedGroupWithMember('acct-1');
      await setAccountStatus('acct-1', status);

      const res = await send(groupId, { accountId: 'acct-1', text: 'hi' });

      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string; accountStatus?: string } };
      expect(body.error.code).toBe('ACCOUNT_UNAVAILABLE');
      expect(body.error.accountStatus).toBe(status);

      const rows = await queryMany<OutboxDbRow>('SELECT * FROM outbox_messages');
      expect(rows).toHaveLength(0);
    },
  );

  it('账号不在该群 → 409 ACCOUNT_NOT_IN_GROUP，且不入队', async () => {
    // acct-1 在群里，acct-2 不在
    const { groupId } = await seedGroupWithMember('acct-1');
    await setAccountStatus('acct-2', 'online');

    const res = await send(groupId, { accountId: 'acct-2', text: 'hi' });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_NOT_IN_GROUP',
    );
    const rows = await queryMany<OutboxDbRow>('SELECT * FROM outbox_messages');
    expect(rows).toHaveLength(0);
  });

  it('群不存在 → 409 ACCOUNT_NOT_IN_GROUP（不存在的群自然无成员）', async () => {
    await setAccountStatus('acct-1', 'online');
    const ghostGroupId = '00000000-0000-0000-0000-000000000000';

    const res = await send(ghostGroupId, { accountId: 'acct-1', text: 'hi' });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_NOT_IN_GROUP',
    );
  });

  it('账号不存在 → 404 NOT_FOUND', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');

    const res = await send(groupId, { accountId: 'acct-ghost', text: 'hi' });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it.each([
    ['缺 accountId', { text: 'hi' }],
    ['accountId 为空串', { accountId: '  ', text: 'hi' }],
    ['缺 text', { accountId: 'acct-1' }],
    ['text 为空串', { accountId: 'acct-1', text: '' }],
  ])('参数非法（%s）→ 400 VALIDATION_ERROR', async (_label, body) => {
    const { groupId } = await seedGroupWithMember('acct-1');

    const res = await send(groupId, body);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('路径参数 id 非 UUID → 400 VALIDATION_ERROR', async () => {
    const res = await send('not-a-uuid', { accountId: 'acct-1', text: 'hi' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('无 token → 401 UNAUTHORIZED（鉴权钩子兜底）', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');

    const res = await send(groupId, { accountId: 'acct-1', text: 'hi' }, null);

    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});
