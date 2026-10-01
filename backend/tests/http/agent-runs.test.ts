/**
 * Agent Run 查询端点测试（B4 页面 4）。
 *
 * 覆盖：
 *  - GET /api/agent-runs/:id：steps 必须含 input / rawResponse（页面 4 展示协议错误原始响应体）
 *  - GET /api/groups/:id/agent-runs：列表
 *  - 404；viewer 可读
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

interface AgentStepDto {
  stepNo: number;
  kind: string;
  name: string | null;
  toolUseId: string | null;
  input: unknown;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string | null;
}

/** 直接构造 run + 两种 step（tool_use / protocol_error）。 */
async function seedRunWithSteps(): Promise<{ groupId: string; runId: string }> {
  const { groupId } = await seedGroupWithMember('acct-1');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (group_id, status, end_reason, summary)
     VALUES ($1, 'failed', 'protocol_errors', 'bad run') RETURNING id`,
    [groupId],
  );
  const runId = rows[0]!.id;

  await pool.query(
    `INSERT INTO agent_steps
       (run_id, step_no, kind, tool_use_id, name, input, result_summary, is_error, error_code, audit_verdict, raw_response)
     VALUES ($1, 1, 'tool_use', 'tu_1', 'send_message', $2::jsonb, '已受理', false, NULL, 'pass', NULL),
            ($1, 2, 'protocol_error', NULL, NULL, NULL, NULL, true, 'BAD_JSON', NULL, $3)`,
    [runId, JSON.stringify({ text: '你好', idempotency_key: 'k-1' }), '```json\n{bad'],
  );

  return { groupId, runId };
}

describe('GET /api/agent-runs/:id（B4 页面 4）', () => {
  it('返回 run 详情，steps 含 input 与 rawResponse', async () => {
    const { runId } = await seedRunWithSteps();

    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-runs/${runId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      id: string;
      status: string;
      endReason: string;
      summary: string;
      steps: AgentStepDto[];
    };
    expect(body.id).toBe(runId);
    expect(body.status).toBe('failed');
    expect(body.endReason).toBe('protocol_errors');
    expect(body.summary).toBe('bad run');
    expect(body.steps).toHaveLength(2);

    const [toolStep, protoStep] = body.steps;
    // tool_use 步：入参原样返回
    expect(toolStep!.kind).toBe('tool_use');
    expect(toolStep!.name).toBe('send_message');
    expect(toolStep!.input).toEqual({ text: '你好', idempotency_key: 'k-1' });
    expect(toolStep!.auditVerdict).toBe('pass');
    expect(toolStep!.rawResponse).toBeNull();

    // 协议错误步：input 为 null，rawResponse 可见（页面 4"查看原始响应体"）
    expect(protoStep!.kind).toBe('protocol_error');
    expect(protoStep!.input).toBeNull();
    expect(protoStep!.isError).toBe(true);
    expect(protoStep!.errorCode).toBe('BAD_JSON');
    expect(protoStep!.rawResponse).toBe('```json\n{bad');
  });

  it('run 不存在 → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent-runs/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('viewer 可读（只读角色允许 GET）', async () => {
    const { runId } = await seedRunWithSteps();
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-runs/${runId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/groups/:id/agent-runs', () => {
  it('返回该群 run 列表（按时间倒序）', async () => {
    const { groupId, runId } = await seedRunWithSteps();
    const res = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/agent-runs`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(runId);
    expect(rows[0]!.status).toBe('failed');
  });
});
