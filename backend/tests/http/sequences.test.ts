/**
 * 定时序列 HTTP 端点测试（B4 页面 5）。
 *
 * 覆盖：
 *  - POST /api/sequences 创建模板（201；viewer 403）
 *  - GET  /api/sequences 列表
 *  - POST /api/sequences/precheck：
 *      200 每步解析预览（resolvedText / resolvedVars / varSources，含黏性 stepVars）
 *      422 UNRESOLVED_PLACEHOLDER 带 stepIndex + key
 *      viewer 403（POST 属写操作，预检弹窗只对 admin 开放）
 *  - POST /api/groups/:id/sequence-runs：201 / 422 / 409
 *  - GET  /api/sequence-runs/:id：steps 含 clientMsgId（pending 时为 null）
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/auth/tokens.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { pool, resetDb, seedGroupWithMember } from '../helpers/db.js';

let app: FastifyInstance;
let adminToken: string;
let viewerToken: string;

const STEPS = [
  { accountRole: 'admin', text: '{event} 将于 {time} 开始', delaySeconds: 0 },
  { accountRole: 'member', text: '资料在 {location}', delaySeconds: 1 },
];

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

async function createSequence(
  token: string,
  steps = STEPS,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sequences',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { name: '测试序列', steps },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('序列模板', () => {
  it('POST 创建 201 + GET 列表可见', async () => {
    const id = await createSequence(adminToken);
    const res = await app.inject({
      method: 'GET',
      url: '/api/sequences',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; name: string }>;
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.name).toBe('测试序列');
  });

  it('viewer 创建 → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sequences',
      headers: { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' },
      payload: { name: 'x', steps: STEPS },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/sequences/precheck（预检弹窗）', () => {
  it('200：返回每步解析后文本与变量来源（黏性 stepVars）', async () => {
    const sequenceId = await createSequence(adminToken);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sequences/precheck',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {
        sequenceId,
        vars: { event: '年会', time: '9点', location: '默认地址' },
        // 第 2 步（stepIndex=1）覆盖 location
        stepVars: { '1': { location: '共享盘/Q2' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      steps: Array<{
        stepIndex: number;
        resolvedText: string;
        resolvedVars: Record<string, string>;
        varSources: Record<string, string>;
      }>;
    };
    expect(body.steps).toHaveLength(2);

    expect(body.steps[0]!.stepIndex).toBe(0);
    expect(body.steps[0]!.resolvedText).toBe('年会 将于 9点 开始');
    expect(body.steps[0]!.resolvedVars['event']).toBe('年会');
    expect(body.steps[0]!.varSources['time']).toBe('default');

    // 黏性覆盖：第 2 步 location 来自 step:1
    expect(body.steps[1]!.resolvedText).toBe('资料在 共享盘/Q2');
    expect(body.steps[1]!.resolvedVars['location']).toBe('共享盘/Q2');
    expect(body.steps[1]!.varSources['location']).toBe('step:1');
  });

  it('422：占位符无法解析 → 带 stepIndex + key，且不创建运行', async () => {
    const sequenceId = await createSequence(adminToken);
    const { groupId } = await seedGroupWithMember('acct-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sequences/precheck',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { sequenceId, vars: { event: '年会', time: '9点' } },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      error: { code: string; stepIndex: number; key: string };
    };
    expect(body.error.code).toBe('UNRESOLVED_PLACEHOLDER');
    expect(body.error.stepIndex).toBe(1);
    expect(body.error.key).toBe('location');

    // 预检不留运行记录
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM sequence_runs WHERE group_id = $1',
      [groupId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('viewer → 403', async () => {
    const sequenceId = await createSequence(adminToken);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sequences/precheck',
      headers: { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' },
      payload: { sequenceId, vars: {} },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('序列运行启动与详情', () => {
  it('启动 201 → 详情含 steps（pending 步 clientMsgId 为 null）', async () => {
    const sequenceId = await createSequence(adminToken);
    const { groupId } = await seedGroupWithMember('acct-1');

    const startRes = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sequence-runs`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: {
        sequenceId,
        vars: { event: '年会', time: '9点', location: '共享盘' },
      },
    });
    expect(startRes.statusCode).toBe(201);
    const { runId } = startRes.json() as { runId: string };

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/sequence-runs/${runId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json() as {
      groupId: string;
      status: string;
      currentStepIndex: number;
      steps: Array<{
        stepIndex: number;
        status: string;
        clientMsgId: string | null;
        scheduledAt: string | null;
        sentAt: string | null;
      }>;
    };
    expect(detail.groupId).toBe(groupId);
    expect(detail.status).toBe('running');
    expect(detail.steps).toHaveLength(2);
    expect(detail.steps[0]!.stepIndex).toBe(0);
    expect(detail.steps[0]!.scheduledAt).not.toBeNull();
    expect(detail.steps[0]!.clientMsgId).toBeNull();
    expect(detail.steps[1]!.scheduledAt).toBeNull();
  });

  it('启动预检失败 → 422 UNRESOLVED_PLACEHOLDER', async () => {
    const sequenceId = await createSequence(adminToken);
    const { groupId } = await seedGroupWithMember('acct-1');

    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sequence-runs`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { sequenceId, vars: { event: '年会' } },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNRESOLVED_PLACEHOLDER');
  });

  it('同群并发两个 running → 第二个 409 SEQUENCE_ALREADY_RUNNING', async () => {
    const sequenceId = await createSequence(adminToken, [
      { accountRole: 'admin', text: 'hello', delaySeconds: 0 },
    ]);
    const { groupId } = await seedGroupWithMember('acct-1');
    const payload = { sequenceId, vars: {} };

    const first = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sequence-runs`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sequence-runs`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe(
      'SEQUENCE_ALREADY_RUNNING',
    );
  });
});
