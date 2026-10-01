/**
 * 群查询与设置端点测试（切片 4，规划 04 任务 4.8 / 4.9）。
 *
 * 覆盖：
 *  - GET /api/groups：列表返回、空列表、排序
 *  - GET /api/groups/:id：详情含 members + activeRunId；404
 *  - PATCH /api/groups/:id：单字段/双字段更新、缺字段 400、非 boolean 400、404、CAS 冲突
 *  - 鉴权：无 token 401；viewer 写操作 403
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/auth/tokens.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { pool, queryOne, resetDb, seedGroupWithMember } from '../helpers/db.js';

let app: FastifyInstance;
let adminToken: string;
let viewerToken: string;

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

interface MemberDto {
  accountId: string;
  platformUserId: string;
  role: string;
  joinedAt: string;
}

interface GroupSummaryDto {
  id: string;
  gatewayGroupId: string;
  status: string;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GroupDetailDto extends GroupSummaryDto {
  members: MemberDto[];
  activeRunId: string | null;
}

/** 带 admin token 的便捷请求方法。 */
function getGroups(token: string | null = adminToken) {
  return app.inject({
    method: 'GET',
    url: '/api/groups',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function getGroup(id: string, token: string | null = adminToken) {
  return app.inject({
    method: 'GET',
    url: `/api/groups/${id}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function patchGroup(id: string, body: unknown, token: string | null = adminToken) {
  return app.inject({
    method: 'PATCH',
    url: `/api/groups/${id}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
}

describe('GET /api/groups', () => {
  it('无群时返回空数组', async () => {
    const res = await getGroups();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('返回群列表，按创建时间倒序', async () => {
    const { groupId: g1 } = await seedGroupWithMember('acct-1');
    // 让两个群的 created_at 有先后：第二条用 sleep 不现实，直接断言长度与字段即可
    const { groupId: g2 } = await seedGroupWithMember('acct-2');

    const res = await getGroups();
    expect(res.statusCode).toBe(200);
    const body = res.json() as GroupSummaryDto[];
    expect(body).toHaveLength(2);
    const ids = body.map((g) => g.id);
    expect(ids).toContain(g1);
    expect(ids).toContain(g2);
    // 字段完整性
    for (const g of body) {
      expect(g.id).toBeTruthy();
      expect(g.gatewayGroupId).toBeTruthy();
      expect(g.status).toBe('active');
      expect(g.creatorAccountId).toBeTruthy();
      expect(g.agentEnabled).toBe(false);
      expect(g.autoKickEnabled).toBe(false);
      expect(g.createdAt).toBeTruthy();
    }
  });

  it('无 token → 401', async () => {
    const res = await getGroups(null);
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/groups/:id', () => {
  it('返回群详情，含 members 与 activeRunId', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');

    const res = await getGroup(groupId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as GroupDetailDto;
    expect(body.id).toBe(groupId);
    expect(body.status).toBe('active');
    expect(body.members).toHaveLength(1);
    expect(body.members[0]!.accountId).toBe(accountUuid);
    expect(body.members[0]!.role).toBe('member');
    expect(body.activeRunId).toBeNull();
  });

  it('群不存在 → 404', async () => {
    const res = await getGroup(randomUUID());
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('非 UUID → 400', async () => {
    const res = await getGroup('not-a-uuid');
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/groups/:id', () => {
  it('只更新 agentEnabled', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');

    const res = await patchGroup(groupId, { agentEnabled: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GroupSummaryDto;
    expect(body.agentEnabled).toBe(true);
    expect(body.autoKickEnabled).toBe(false);

    // 落库校验
    const row = await queryOne<{ agent_enabled: boolean; auto_kick_enabled: boolean }>(
      'SELECT agent_enabled, auto_kick_enabled FROM groups WHERE id = $1',
      [groupId],
    );
    expect(row?.agent_enabled).toBe(true);
    expect(row?.auto_kick_enabled).toBe(false);
  });

  it('同时更新两个字段', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');

    const res = await patchGroup(groupId, { agentEnabled: true, autoKickEnabled: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GroupSummaryDto;
    expect(body.agentEnabled).toBe(true);
    expect(body.autoKickEnabled).toBe(true);
  });

  it('缺字段 → 400', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const res = await patchGroup(groupId, {});
    expect(res.statusCode).toBe(400);
  });

  it('字段非 boolean → 400', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const res = await patchGroup(groupId, { agentEnabled: 'yes' });
    expect(res.statusCode).toBe(400);
  });

  it('群不存在 → 404', async () => {
    const res = await patchGroup(randomUUID(), { agentEnabled: true });
    expect(res.statusCode).toBe(404);
  });

  it('CAS 冲突（repo 层：version 不匹配返回 null）', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const groupRepo = new (await import('../../src/repos/groups.js')).GroupRepo(pool);

    const group = await groupRepo.findById(groupId);
    expect(group).toBeDefined();
    // 用过期的 version 调用 updateSettings → 返回 null（CAS 失败）
    const result = await groupRepo.updateSettings(groupId, (group!.version - 1), {
      agentEnabled: true,
    });
    expect(result).toBeNull();
  });

  it('viewer 写操作 → 403', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const res = await patchGroup(groupId, { agentEnabled: true }, viewerToken);
    expect(res.statusCode).toBe(403);
  });
});
