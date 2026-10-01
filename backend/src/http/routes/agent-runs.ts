/**
 * Agent Run 查询路由：
 *   - GET /api/agent-runs/:id     — run 详情 + steps
 *   - GET /api/groups/:id/agent-runs — 群的 run 列表
 *
 * 仅查询接口（viewer 可读）。
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AgentRunRepo } from '../../repos/agent-runs.js';
import { AppError } from '../errors.js';

export async function registerAgentRunRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  /** GET /api/agent-runs/:id */
  app.get('/api/agent-runs/:id', async (req) => {
    const runId = (req.params as { id: string }).id;
    const repo = new AgentRunRepo(pool);
    const client = await pool.connect();
    try {
      const run = await repo.getRun(client, runId);
      if (run === undefined) throw AppError.notFound('Agent run 不存在');
      const steps = await repo.listSteps(client, runId);
      return {
        id: run.id,
        groupId: run.groupId,
        status: run.status,
        endReason: run.endReason,
        summary: run.summary,
        accumulatedMs: run.accumulatedMs,
        createdAt: run.createdAt.toISOString(),
        steps: steps.map((s) => ({
          stepNo: s.stepNo,
          kind: s.kind,
          name: s.name,
          toolUseId: s.toolUseId,
          isError: s.isError,
          errorCode: s.errorCode,
          auditVerdict: s.auditVerdict,
          resultSummary: s.resultSummary,
          createdAt: s.createdAt.toISOString(),
        })),
      };
    } finally {
      client.release();
    }
  });

  /** GET /api/groups/:id/agent-runs */
  app.get('/api/groups/:id/agent-runs', async (req) => {
    const groupId = (req.params as { id: string }).id;
    const repo = new AgentRunRepo(pool);
    const client = await pool.connect();
    try {
      const runs = await repo.listByGroup(client, groupId);
      return runs.map((r) => ({
        id: r.id,
        status: r.status,
        endReason: r.endReason,
        summary: r.summary,
        accumulatedMs: r.accumulatedMs,
        createdAt: r.createdAt.toISOString(),
      }));
    } finally {
      client.release();
    }
  });
}
