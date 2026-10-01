/**
 * Agent 运行仓储层（规划 05 §2）。
 *
 * 表：agent_runs / agent_run_messages / agent_steps / agent_tool_calls / agent_run_pending_messages
 */
import type { Pool, PoolClient } from 'pg';
import type { Queryable } from './web-events.js';

export type AgentRunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';
export type AgentEndReason =
  | 'final'
  | 'budget_exhausted'
  | 'wall_clock'
  | 'protocol_errors'
  | 'audit_blocked'
  | 'cancelled';
export type AgentStepKind = 'tool_use' | 'final' | 'protocol_error';
export type AgentToolCallState = 'pending_execution' | 'executed';

export interface AgentRunRow {
  readonly id: string;
  readonly groupId: string;
  readonly status: AgentRunStatus;
  readonly endReason: AgentEndReason | null;
  readonly summary: string | null;
  readonly accumulatedMs: number;
  readonly lastTickAt: Date | null;
  readonly createdAt: Date;
}

export interface AgentRunMessageRow {
  readonly id: number;
  readonly runId: string;
  readonly role: 'user' | 'assistant';
  readonly blocks: unknown;
}

export interface AgentStepRow {
  readonly id: string;
  readonly runId: string;
  readonly stepNo: number;
  readonly kind: AgentStepKind;
  readonly toolUseId: string | null;
  readonly name: string | null;
  readonly input: unknown;
  readonly resultSummary: string | null;
  readonly isError: boolean;
  readonly errorCode: string | null;
  readonly auditVerdict: string | null;
  readonly rawResponse: string | null;
  readonly createdAt: Date;
}

interface DbAgentRun {
  id: string;
  group_id: string;
  status: AgentRunStatus;
  end_reason: AgentEndReason | null;
  summary: string | null;
  accumulated_ms: number;
  last_tick_at: Date | null;
  created_at: Date;
}

interface DbAgentRunMessage {
  id: string;
  run_id: string;
  role: 'user' | 'assistant';
  blocks: unknown;
}

interface DbAgentStep {
  id: string;
  run_id: string;
  step_no: number;
  kind: AgentStepKind;
  tool_use_id: string | null;
  name: string | null;
  input: unknown;
  result_summary: string | null;
  is_error: boolean;
  error_code: string | null;
  audit_verdict: string | null;
  raw_response: string | null;
  created_at: Date;
}

function fromDbRun(r: DbAgentRun): AgentRunRow {
  return {
    id: r.id,
    groupId: r.group_id,
    status: r.status,
    endReason: r.end_reason,
    summary: r.summary,
    accumulatedMs: r.accumulated_ms,
    lastTickAt: r.last_tick_at,
    createdAt: r.created_at,
  };
}

function fromDbStep(r: DbAgentStep): AgentStepRow {
  return {
    id: r.id,
    runId: r.run_id,
    stepNo: r.step_no,
    kind: r.kind,
    toolUseId: r.tool_use_id,
    name: r.name,
    input: r.input,
    resultSummary: r.result_summary,
    isError: r.is_error,
    errorCode: r.error_code,
    auditVerdict: r.audit_verdict,
    rawResponse: r.raw_response,
    createdAt: r.created_at,
  };
}

export class AgentRunRepo {
  constructor(private readonly pool: Pool) {}

  /** 创建 run，冲突（唯一索引）返回 null。 */
  async createRun(client: PoolClient, groupId: string): Promise<AgentRunRow | null> {
    try {
      const { rows } = await client.query<DbAgentRun>(
        `INSERT INTO agent_runs (group_id, status) VALUES ($1, 'running')
         RETURNING *`,
        [groupId],
      );
      return rows[0] !== undefined ? fromDbRun(rows[0]) : null;
    } catch (err) {
      // 唯一索引冲突 = 已有 running run
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async getRun(queryable: Queryable, runId: string): Promise<AgentRunRow | undefined> {
    const { rows } = await queryable.query<DbAgentRun>(
      'SELECT * FROM agent_runs WHERE id = $1',
      [runId],
    );
    return rows[0] !== undefined ? fromDbRun(rows[0]) : undefined;
  }

  /** 列出群的所有 run，按创建时间倒序。 */
  async listByGroup(queryable: Queryable, groupId: string): Promise<AgentRunRow[]> {
    const { rows } = await queryable.query<DbAgentRun>(
      'SELECT * FROM agent_runs WHERE group_id = $1 ORDER BY created_at DESC',
      [groupId],
    );
    return rows.map(fromDbRun);
  }

  /** 更新 run 状态与结束信息。 */
  async finishRun(
    client: PoolClient,
    runId: string,
    status: AgentRunStatus,
    endReason: AgentEndReason,
    summary: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE agent_runs SET status = $1, end_reason = $2, summary = $3, last_tick_at = now()
       WHERE id = $4`,
      [status, endReason, summary, runId],
    );
  }

  /** 累加 accumulated_ms 并刷新 last_tick_at。 */
  async tickAccumulated(client: PoolClient, runId: string, elapsedMs: number): Promise<void> {
    await client.query(
      `UPDATE agent_runs
       SET accumulated_ms = accumulated_ms + $1, last_tick_at = now()
       WHERE id = $2`,
      [elapsedMs, runId],
    );
  }

  // --- messages ---

  /** 追加一条对话消息，返回其自增 id。 */
  async appendMessage(
    client: PoolClient,
    runId: string,
    role: 'user' | 'assistant',
    blocks: unknown,
  ): Promise<number> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO agent_run_messages (run_id, role, blocks)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [runId, role, JSON.stringify(blocks)],
    );
    return Number(rows[0]!.id);
  }

  /** 恢复时重建 messages 数组。 */
  async loadMessages(queryable: Queryable, runId: string): Promise<AgentRunMessageRow[]> {
    const { rows } = await queryable.query<DbAgentRunMessage>(
      'SELECT id, run_id, role, blocks FROM agent_run_messages WHERE run_id = $1 ORDER BY id ASC',
      [runId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      runId: r.run_id,
      role: r.role,
      blocks: r.blocks,
    }));
  }

  // --- steps ---

  async insertStep(
    client: PoolClient,
    runId: string,
    stepNo: number,
    step: Omit<AgentStepRow, 'id' | 'runId' | 'stepNo' | 'createdAt'>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO agent_steps
         (run_id, step_no, kind, tool_use_id, name, input, result_summary,
          is_error, error_code, audit_verdict, raw_response)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
      [
        runId, stepNo, step.kind, step.toolUseId, step.name,
        step.input !== null ? JSON.stringify(step.input) : null,
        step.resultSummary, step.isError, step.errorCode, step.auditVerdict, step.rawResponse,
      ],
    );
  }

  async listSteps(queryable: Queryable, runId: string): Promise<AgentStepRow[]> {
    const { rows } = await queryable.query<DbAgentStep>(
      'SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY step_no ASC',
      [runId],
    );
    return rows.map(fromDbStep);
  }

  // --- pending messages ---

  async addPendingMessage(client: PoolClient, runId: string, msgId: string): Promise<void> {
    await client.query(
      `INSERT INTO agent_run_pending_messages (run_id, msg_id) VALUES ($1, $2)
       ON CONFLICT (run_id, msg_id) DO NOTHING`,
      [runId, msgId],
    );
  }

  async listPendingMessages(client: PoolClient, runId: string): Promise<string[]> {
    const { rows } = await client.query<{ msg_id: string }>(
      'SELECT msg_id FROM agent_run_pending_messages WHERE run_id = $1',
      [runId],
    );
    return rows.map((r) => r.msg_id);
  }

  async clearPendingMessages(client: PoolClient, runId: string): Promise<void> {
    await client.query('DELETE FROM agent_run_pending_messages WHERE run_id = $1', [runId]);
  }

  // --- tool calls (幂等键) ---

  /** 查同 run 同 idempotency_key 的工具调用记录。 */
  async getToolCall(
    queryable: Queryable,
    runId: string,
    idempotencyKey: string,
  ): Promise<{ outboxId: string | null; state: AgentToolCallState; toolUseId: string; idempotencyKey: string; clientMsgId: string | null } | undefined> {
    const { rows } = await queryable.query<{
      outbox_id: string | null;
      state: AgentToolCallState;
      tool_use_id: string;
      idempotency_key: string;
      client_msg_id: string | null;
    }>(
      `SELECT outbox_id, state, tool_use_id, idempotency_key, client_msg_id FROM agent_tool_calls
       WHERE run_id = $1 AND idempotency_key = $2`,
      [runId, idempotencyKey],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { outboxId: row.outbox_id, state: row.state, toolUseId: row.tool_use_id, idempotencyKey: row.idempotency_key, clientMsgId: row.client_msg_id };
  }

  /** 按 tool_use_id 查工具调用记录（崩溃恢复时定位未完成的调用）。 */
  async getToolCallByToolUseId(
    queryable: Queryable,
    runId: string,
    toolUseId: string,
  ): Promise<{ outboxId: string | null; state: AgentToolCallState; idempotencyKey: string; clientMsgId: string | null } | undefined> {
    const { rows } = await queryable.query<{
      outbox_id: string | null;
      state: AgentToolCallState;
      idempotency_key: string;
      client_msg_id: string | null;
    }>(
      `SELECT outbox_id, state, idempotency_key, client_msg_id FROM agent_tool_calls
       WHERE run_id = $1 AND tool_use_id = $2`,
      [runId, toolUseId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { outboxId: row.outbox_id, state: row.state, idempotencyKey: row.idempotency_key, clientMsgId: row.client_msg_id };
  }

  /**
   * 记录一条工具调用为 pending_execution（审计通过后、执行前）。
   *
   * clientMsgId：本次调用入队 outbox 时生成的 client_msg_id（UUID）。
   * 崩溃恢复时靠它定位"已入队但 markToolCallExecuted 未落库"的孤儿 outbox 行
   * （不能用 idempotencyKey——agent 可能用任意非 UUID 字符串作 key，
   * 且 run 维度的 key 撞不上全局唯一的 outbox.client_msg_id）。
   */
  async recordToolCall(
    client: PoolClient,
    runId: string,
    idempotencyKey: string,
    toolUseId: string,
    clientMsgId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO agent_tool_calls (run_id, idempotency_key, tool_use_id, state, client_msg_id)
       VALUES ($1, $2, $3, 'pending_execution', $4)`,
      [runId, idempotencyKey, toolUseId, clientMsgId],
    );
  }

  /** 标记工具调用已执行（关联 outbox_id）。 */
  async markToolCallExecuted(
    client: PoolClient,
    runId: string,
    idempotencyKey: string,
    outboxId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE agent_tool_calls SET state = 'executed', outbox_id = $1
       WHERE run_id = $2 AND idempotency_key = $3`,
      [outboxId, runId, idempotencyKey],
    );
  }
}

/** 判断是否为 PostgreSQL 唯一约束冲突（23505）。 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
