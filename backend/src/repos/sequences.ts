/**
 * 定时序列仓储层（规划 05 §3）。
 *
 * 表：sequences / sequence_runs / sequence_steps
 *   - sequences: 序列模板（name + steps JSON）
 *   - sequence_runs: 运行实例（同一群至多一个 running，partial unique index）
 *   - sequence_steps: 每步的状态、排期时间、关联 outbox、解析后的变量
 */
import type { Pool, PoolClient } from 'pg';
import type { Queryable } from './web-events.js';

export type SequenceRunStatus = 'running' | 'finished' | 'failed' | 'stopped';
export type SequenceStepStatus = 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';

/** 序列模板的单步定义。 */
export interface SequenceStepDef {
  readonly text: string;
  readonly delaySeconds: number;
  readonly accountRole: 'admin' | 'member';
}

export interface SequenceRow {
  readonly id: string;
  readonly name: string;
  readonly steps: SequenceStepDef[];
  readonly createdAt: Date;
}

export interface SequenceRunRow {
  readonly id: string;
  readonly groupId: string;
  readonly sequenceId: string;
  readonly status: SequenceRunStatus;
  readonly vars: Record<string, string>;
  readonly stepVars: Record<string, Record<string, string>>;
  readonly currentStepIndex: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SequenceStepRow {
  readonly id: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly status: SequenceStepStatus;
  readonly outboxId: string | null;
  readonly clientMsgId: string | null;
  readonly scheduledAt: Date | null;
  readonly sentAt: Date | null;
  readonly resolvedVars: Record<string, string> | null;
  readonly varSources: Record<string, string> | null;
  readonly updatedAt: Date;
}

interface DbSequence {
  id: string;
  name: string;
  steps: unknown;
  created_at: Date;
}

interface DbSequenceRun {
  id: string;
  group_id: string;
  sequence_id: string;
  status: SequenceRunStatus;
  vars: unknown;
  step_vars: unknown;
  current_step_index: number;
  created_at: Date;
  updated_at: Date;
}

interface DbSequenceStep {
  id: string;
  run_id: string;
  step_index: number;
  status: SequenceStepStatus;
  outbox_id: string | null;
  scheduled_at: Date | null;
  sent_at: Date | null;
  resolved_vars: unknown;
  var_sources: unknown;
  updated_at: Date;
}

function fromDbSequence(r: DbSequence): SequenceRow {
  return {
    id: r.id,
    name: r.name,
    steps: (r.steps as SequenceStepDef[]) ?? [],
    createdAt: r.created_at,
  };
}

function fromDbRun(r: DbSequenceRun): SequenceRunRow {
  return {
    id: r.id,
    groupId: r.group_id,
    sequenceId: r.sequence_id,
    status: r.status,
    vars: (r.vars as Record<string, string>) ?? {},
    stepVars: (r.step_vars as Record<string, Record<string, string>>) ?? {},
    currentStepIndex: r.current_step_index,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function fromDbStep(r: DbSequenceStep): SequenceStepRow {
  // client_msg_id 列在 0009 迁移中添加；这里从 outbox 关联取，避免加列查询复杂度。
  // 实际 clientMsgId 通过 outbox_id 关联 outbox_messages.client_msg_id 获取。
  return {
    id: r.id,
    runId: r.run_id,
    stepIndex: r.step_index,
    status: r.status,
    outboxId: r.outbox_id,
    clientMsgId: null,
    scheduledAt: r.scheduled_at,
    sentAt: r.sent_at,
    resolvedVars: (r.resolved_vars as Record<string, string>) ?? null,
    varSources: (r.var_sources as Record<string, string>) ?? null,
    updatedAt: r.updated_at,
  };
}

export class SequenceRepo {
  constructor(private readonly pool: Pool) {}

  // --- sequences ---

  async createSequence(queryable: Queryable, name: string, steps: SequenceStepDef[]): Promise<SequenceRow> {
    const { rows } = await queryable.query<DbSequence>(
      `INSERT INTO sequences (name, steps) VALUES ($1, $2::jsonb) RETURNING *`,
      [name, JSON.stringify(steps)],
    );
    return fromDbSequence(rows[0]!);
  }

  async getSequence(queryable: Queryable, id: string): Promise<SequenceRow | undefined> {
    const { rows } = await queryable.query<DbSequence>(
      'SELECT * FROM sequences WHERE id = $1',
      [id],
    );
    return rows[0] !== undefined ? fromDbSequence(rows[0]) : undefined;
  }

  async listSequences(queryable: Queryable): Promise<SequenceRow[]> {
    const { rows } = await queryable.query<DbSequence>(
      'SELECT * FROM sequences ORDER BY created_at DESC',
    );
    return rows.map(fromDbSequence);
  }

  // --- runs ---

  /**
   * 创建序列运行。同一群已有 running → 返回 null（409 SEQUENCE_ALREADY_RUNNING）。
   */
  async createRun(
    client: PoolClient,
    groupId: string,
    sequenceId: string,
    vars: Record<string, string>,
    stepVars: Record<string, Record<string, string>>,
  ): Promise<SequenceRunRow | null> {
    try {
      const { rows } = await client.query<DbSequenceRun>(
        `INSERT INTO sequence_runs (group_id, sequence_id, status, vars, step_vars)
         VALUES ($1, $2, 'running', $3::jsonb, $4::jsonb)
         RETURNING *`,
        [groupId, sequenceId, JSON.stringify(vars), JSON.stringify(stepVars)],
      );
      return fromDbRun(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async getRun(queryable: Queryable, runId: string): Promise<SequenceRunRow | undefined> {
    const { rows } = await queryable.query<DbSequenceRun>(
      'SELECT * FROM sequence_runs WHERE id = $1',
      [runId],
    );
    return rows[0] !== undefined ? fromDbRun(rows[0]) : undefined;
  }

  async listRunsByGroup(queryable: Queryable, groupId: string): Promise<SequenceRunRow[]> {
    const { rows } = await queryable.query<DbSequenceRun>(
      'SELECT * FROM sequence_runs WHERE group_id = $1 ORDER BY created_at DESC',
      [groupId],
    );
    return rows.map(fromDbRun);
  }

  async finishRun(client: PoolClient, runId: string, status: SequenceRunStatus): Promise<void> {
    await client.query(
      `UPDATE sequence_runs SET status = $1, updated_at = now() WHERE id = $2`,
      [status, runId],
    );
  }

  async advanceCurrentStep(client: PoolClient, runId: string, nextIndex: number): Promise<void> {
    await client.query(
      `UPDATE sequence_runs SET current_step_index = $1, updated_at = now() WHERE id = $2`,
      [nextIndex, runId],
    );
  }

  // --- steps ---

  /** 批量插入步骤（启动时一次性写入）。 */
  async insertSteps(
    client: PoolClient,
    runId: string,
    steps: Array<{ stepIndex: number; scheduledAt: Date | null }>,
  ): Promise<void> {
    for (const s of steps) {
      await client.query(
        `INSERT INTO sequence_steps (run_id, step_index, status, scheduled_at)
         VALUES ($1, $2, 'pending', $3)`,
        [runId, s.stepIndex, s.scheduledAt],
      );
    }
  }

  async getSteps(queryable: Queryable, runId: string): Promise<SequenceStepRow[]> {
    const { rows } = await queryable.query<DbSequenceStep>(
      'SELECT * FROM sequence_steps WHERE run_id = $1 ORDER BY step_index ASC',
      [runId],
    );
    return rows.map(fromDbStep);
  }

  /**
   * 取到期的 pending 步骤（scheduled_at <= now()）。
   * 按 run_id, step_index 排序，保证同 run 内步骤顺序。
   */
  async findDuePendingSteps(queryable: Queryable): Promise<SequenceStepRow[]> {
    const { rows } = await queryable.query<DbSequenceStep>(
      `SELECT * FROM sequence_steps
       WHERE status = 'pending' AND scheduled_at <= now()
       ORDER BY run_id ASC, step_index ASC`,
    );
    return rows.map(fromDbStep);
  }

  /** 取 accepted 步骤（已入队 outbox，等待投递完成），用于轮询投递状态。 */
  async findAcceptedSteps(queryable: Queryable): Promise<Array<SequenceStepRow & { deliveryStatus: string }>> {
    const { rows } = await queryable.query<DbSequenceStep & { delivery_status: string }>(
      `SELECT ss.*, om.delivery_status
       FROM sequence_steps ss
       JOIN outbox_messages om ON om.id = ss.outbox_id
       WHERE ss.status = 'accepted'`,
    );
    return rows.map((r) => ({ ...fromDbStep(r), deliveryStatus: r.delivery_status }));
  }

  /** 标记步骤为 accepted（已入队 outbox）。 */
  async markStepAccepted(
    client: PoolClient,
    runId: string,
    stepIndex: number,
    outboxId: string,
    resolvedVars: Record<string, string>,
    varSources: Record<string, string>,
  ): Promise<void> {
    await client.query(
      `UPDATE sequence_steps
       SET status = 'accepted', outbox_id = $1, resolved_vars = $2::jsonb, var_sources = $3::jsonb, updated_at = now()
       WHERE run_id = $4 AND step_index = $5`,
      [outboxId, JSON.stringify(resolvedVars), JSON.stringify(varSources), runId, stepIndex],
    );
  }

  /** 标记步骤为 sent（message_sent 事件触发）。 */
  async markStepSent(client: PoolClient, runId: string, stepIndex: number, sentAt: Date): Promise<void> {
    await client.query(
      `UPDATE sequence_steps SET status = 'sent', sent_at = $1, updated_at = now()
       WHERE run_id = $2 AND step_index = $3`,
      [sentAt, runId, stepIndex],
    );
  }

  /** 标记步骤为 skipped（无可用账号）。 */
  async markStepSkipped(client: PoolClient, runId: string, stepIndex: number): Promise<void> {
    await client.query(
      `UPDATE sequence_steps SET status = 'skipped', updated_at = now()
       WHERE run_id = $1 AND step_index = $2`,
      [runId, stepIndex],
    );
  }

  /** 标记步骤为 failed（投递失败）。 */
  async markStepFailed(client: PoolClient, runId: string, stepIndex: number): Promise<void> {
    await client.query(
      `UPDATE sequence_steps SET status = 'failed', updated_at = now()
       WHERE run_id = $1 AND step_index = $2`,
      [runId, stepIndex],
    );
  }

  /** 设置下一步的 scheduled_at。 */
  async scheduleStep(client: PoolClient, runId: string, stepIndex: number, scheduledAt: Date): Promise<void> {
    await client.query(
      `UPDATE sequence_steps SET scheduled_at = $1, updated_at = now()
       WHERE run_id = $2 AND step_index = $3`,
      [scheduledAt, runId, stepIndex],
    );
  }

  /** 通过 outbox_id 反查步骤（message_sent 时推进用）。 */
  async findStepByOutboxId(
    queryable: Queryable,
    outboxId: string,
  ): Promise<{ runId: string; stepIndex: number; status: SequenceStepStatus } | undefined> {
    const { rows } = await queryable.query<{ run_id: string; step_index: number; status: SequenceStepStatus }>(
      `SELECT run_id, step_index, status FROM sequence_steps WHERE outbox_id = $1 LIMIT 1`,
      [outboxId],
    );
    return rows[0] !== undefined
      ? { runId: rows[0].run_id, stepIndex: rows[0].step_index, status: rows[0].status }
      : undefined;
  }
}

/** 判断是否为 PostgreSQL 唯一约束冲突（23505）。 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
