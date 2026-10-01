/**
 * 定时序列路由（规划 05 §3）：
 *   - POST /api/sequences              创建序列模板 → 201 { id }
 *   - GET  /api/sequences              序列列表
 *   - POST /api/groups/:id/sequence-runs  启动序列运行 → 201 { runId }
 *                                         409 SEQUENCE_ALREADY_RUNNING
 *                                         422 UNRESOLVED_PLACEHOLDER { stepIndex, key }
 *   - GET  /api/groups/:id/sequence-runs  群的序列运行列表
 *   - GET  /api/sequence-runs/:id      运行详情（含步骤）
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AppError, ErrorCode } from '../errors.js';
import { SequenceRepo, type SequenceStepDef } from '../../repos/sequences.js';
import { startSequenceRun } from '../../services/sequence-runner.js';
import { GroupRepo } from '../../repos/groups.js';
import { AccountRepo } from '../../repos/accounts.js';
import { OutboxRepo } from '../../repos/outbox.js';

interface RouteDeps {
  pool: Pool;
}

export async function registerSequenceRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const sequenceRepo = new SequenceRepo(deps.pool);
  const groupRepo = new GroupRepo(deps.pool);
  const accountRepo = new AccountRepo(deps.pool);
  const outboxRepo = new OutboxRepo(deps.pool);

  // POST /api/sequences — 创建序列模板
  app.post<{ Body: { name?: string; steps?: unknown } }>(
    '/api/sequences',
    async (req, reply) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (name === '') {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'name 不能为空');
      }
      const rawSteps = req.body?.steps;
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'steps 必须是非空数组');
      }
      const steps: SequenceStepDef[] = rawSteps.map((s, i) => {
        const rec = s as Record<string, unknown>;
        const text = typeof rec['text'] === 'string' ? rec['text'] : '';
        const delaySeconds = typeof rec['delaySeconds'] === 'number' ? rec['delaySeconds'] : 0;
        const accountRole = rec['accountRole'] === 'member' ? 'member' : 'admin';
        if (text === '') {
          throw new AppError(400, ErrorCode.VALIDATION_ERROR, `steps[${i}].text 不能为空`);
        }
        if (delaySeconds < 0) {
          throw new AppError(400, ErrorCode.VALIDATION_ERROR, `steps[${i}].delaySeconds 不能为负`);
        }
        return { text, delaySeconds, accountRole };
      });

      const client = await deps.pool.connect();
      try {
        const seq = await sequenceRepo.createSequence(client, name, steps);
        return reply.code(201).send({ id: seq.id, name: seq.name, steps: seq.steps });
      } finally {
        client.release();
      }
    },
  );

  // GET /api/sequences — 序列列表
  app.get('/api/sequences', async () => {
    const seqs = await sequenceRepo.listSequences(deps.pool);
    return seqs.map((s) => ({ id: s.id, name: s.name, steps: s.steps, createdAt: s.createdAt }));
  });

  // POST /api/groups/:id/sequence-runs — 启动序列运行
  app.post<{ Params: { id: string }; Body: { sequenceId?: string; vars?: unknown; stepVars?: unknown } }>(
    '/api/groups/:id/sequence-runs',
    async (req, reply) => {
      const groupId = req.params.id;
      const sequenceId = typeof req.body?.sequenceId === 'string' ? req.body.sequenceId : '';
      if (sequenceId === '') {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'sequenceId 不能为空');
      }
      const vars = (req.body?.vars ?? {}) as Record<string, string>;
      const stepVars = (req.body?.stepVars ?? {}) as Record<string, Record<string, string>>;

      try {
        const runId = await startSequenceRun(
          { pool: deps.pool, sequenceRepo, groupRepo, accountRepo, outboxRepo, log: req.log },
          groupId,
          sequenceId,
          vars,
          stepVars,
        );
        return reply.code(201).send({ runId });
      } catch (err) {
        throw toAppError(err);
      }
    },
  );

  // GET /api/groups/:id/sequence-runs — 群的序列运行列表
  app.get<{ Params: { id: string } }>('/api/groups/:id/sequence-runs', async (req) => {
    const runs = await sequenceRepo.listRunsByGroup(deps.pool, req.params.id);
    return runs.map((r) => ({
      id: r.id,
      sequenceId: r.sequenceId,
      status: r.status,
      currentStepIndex: r.currentStepIndex,
      createdAt: r.createdAt,
    }));
  });

  // GET /api/sequence-runs/:id — 运行详情（含步骤）
  app.get<{ Params: { id: string } }>('/api/sequence-runs/:id', async (req) => {
    const run = await sequenceRepo.getRun(deps.pool, req.params.id);
    if (run === undefined) {
      throw new AppError(404, ErrorCode.NOT_FOUND, '序列运行不存在');
    }
    const steps = await sequenceRepo.getSteps(deps.pool, run.id);
    return {
      id: run.id,
      groupId: run.groupId,
      sequenceId: run.sequenceId,
      status: run.status,
      currentStepIndex: run.currentStepIndex,
      vars: run.vars,
      stepVars: run.stepVars,
      createdAt: run.createdAt,
      steps: steps.map((s) => ({
        stepIndex: s.stepIndex,
        status: s.status,
        outboxId: s.outboxId,
        scheduledAt: s.scheduledAt,
        sentAt: s.sentAt,
        resolvedVars: s.resolvedVars,
        varSources: s.varSources,
      })),
    };
  });
}

/** 把 startSequenceRun 抛出的错误转为 AppError。 */
function toAppError(err: unknown): AppError {
  if (err instanceof Error) {
    if (err.message === 'SEQUENCE_ALREADY_RUNNING') {
      return new AppError(409, ErrorCode.SEQUENCE_ALREADY_RUNNING, '同群已有运行中的序列');
    }
    if (err.message.startsWith('UNRESOLVED_PLACEHOLDER')) {
      const e = err as Error & { stepIndex?: number; key?: string };
      return new AppError(422, ErrorCode.UNRESOLVED_PLACEHOLDER, `占位符无法解析`, {
        stepIndex: e.stepIndex ?? 0,
        key: e.key ?? '',
      });
    }
    if (err.message.startsWith('SEQUENCE_NOT_FOUND')) {
      return new AppError(404, ErrorCode.NOT_FOUND, '序列不存在');
    }
  }
  throw err;
}
