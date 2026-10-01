/**
 * 异步 job 仓储层：jobs / group_job_members 表的 SQL 只出现在这里。
 *
 * 语义（规划 04 §2）：
 *  - 建群 job 在 `POST /api/groups` 的**事务内**落库（status='running', errors=[]），
 *    与 202 响应原子生效——响应发出则 job 一定存在，worker 重启后可续跑；
 *  - group_job_members 记录每个待加入成员的进度：
 *      join_requested_at  发出网关 join 的时刻（持久化 JOIN_TIMEOUT 判定基准）
 *      joined_at          收到 member_joined 的时刻
 *      promote_calls      promote 调用次数（硬上限 2）
 *
 * 本批次（4.1/4.2/4.7）实现"创建 + 查询"；批次 2（4.3-4.6）补充 worker 推进方法。
 */
import type { Pool, PoolClient } from 'pg';

export type JobKind = 'create_group' | 'leave_all';
export type JobStatus = 'running' | 'finished' | 'failed';

/** errors 数组元素（题目契约：{ step, code }）。 */
export interface JobError {
  readonly step: string;
  readonly code: string;
}

export interface JobRow {
  readonly id: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly payload: Record<string, unknown>;
  readonly errors: JobError[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface JobMemberRow {
  readonly jobId: string;
  readonly accountId: string;
  readonly joinRequestedAt: Date | null;
  readonly joinedAt: Date | null;
  readonly promoteCalls: number;
}

interface DbJobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  errors: JobError[];
  created_at: Date;
  updated_at: Date;
}

interface DbJobMemberRow {
  job_id: string;
  account_id: string;
  join_requested_at: Date | null;
  joined_at: Date | null;
  promote_calls: number;
}

function fromDb(row: DbJobRow): JobRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: row.payload,
    errors: row.errors,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromDbMember(row: DbJobMemberRow): JobMemberRow {
  return {
    jobId: row.job_id,
    accountId: row.account_id,
    joinRequestedAt: row.join_requested_at,
    joinedAt: row.joined_at,
    promoteCalls: row.promote_calls,
  };
}

/** 建群 job 的创建入参（account 均已解析为内部 UUID）。 */
export interface CreateGroupJobInput {
  /** 创建者账号 UUID（accounts.id）。 */
  readonly creatorAccountUuid: string;
  /** 待加入成员账号 UUID 列表（不含创建者，顺序即 promote 顺序）。 */
  readonly memberAccountUuids: readonly string[];
  /** 随 job 持久化的原始入参（文本 accountId，重启恢复用）。 */
  readonly payload: Record<string, unknown>;
}

export class JobRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * 创建建群 job：同事务 INSERT jobs + group_job_members（每个成员一行）。
   * 必须在调用方事务内调用（与 202 响应原子生效）。
   * @returns 新 job 的 id
   */
  async createCreateGroupJob(client: PoolClient, input: CreateGroupJobInput): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO jobs (kind, status, payload)
       VALUES ('create_group', 'running', $1::jsonb)
       RETURNING id`,
      [JSON.stringify(input.payload)],
    );
    const jobId = rows[0]?.id;
    if (jobId === undefined) throw new Error('创建 job 失败');

    // 单条多行 INSERT（unnest 展开数组），成员再多也只需一次往返
    if (input.memberAccountUuids.length > 0) {
      await client.query(
        `INSERT INTO group_job_members (job_id, account_id)
         SELECT $1, unnest($2::uuid[])`,
        [jobId, input.memberAccountUuids],
      );
    }
    return jobId;
  }

  /** 按 id 查 job；不存在返回 undefined。 */
  async findById(jobId: string): Promise<JobRow | undefined> {
    const { rows } = await this.pool.query<DbJobRow>(
      'SELECT * FROM jobs WHERE id = $1',
      [jobId],
    );
    return rows[0] !== undefined ? fromDb(rows[0]) : undefined;
  }

  // -------------------------------------------------------------------------
  // 批次 2：worker 推进方法（4.3-4.6）
  // -------------------------------------------------------------------------

  /** 取一个可执行的 create_group job（单条；多实例场景由 advisory lock 兜底）。 */
  async listRunnableCreateGroupJobs(limit = 10): Promise<JobRow[]> {
    const { rows } = await this.pool.query<DbJobRow>(
      `SELECT * FROM jobs
       WHERE kind = 'create_group' AND status = 'running'
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map(fromDb);
  }

  /** 查询 job 的成员进度（含 join_requested_at / joined_at / promote_calls）。 */
  async listJobMembers(jobId: string): Promise<JobMemberRow[]> {
    const { rows } = await this.pool.query<DbJobMemberRow>(
      `SELECT * FROM group_job_members WHERE job_id = $1 ORDER BY account_id`,
      [jobId],
    );
    return rows.map(fromDbMember);
  }

  /** 标记某成员已发出 join 请求（JOIN_TIMEOUT 判定基准）。 */
  async markJoinRequested(client: PoolClient, jobId: string, accountId: string): Promise<void> {
    await client.query(
      `UPDATE group_job_members
       SET join_requested_at = now()
       WHERE job_id = $1 AND account_id = $2`,
      [jobId, accountId],
    );
  }

  /** 标记某成员已入群（member_joined 到达时调用）。 */
  async markJoined(client: PoolClient, jobId: string, accountId: string): Promise<void> {
    await client.query(
      `UPDATE group_job_members
       SET joined_at = now()
       WHERE job_id = $1 AND account_id = $2`,
      [jobId, accountId],
    );
  }

  /** promote 调用次数 +1，返回新计数。 */
  async incrementPromoteCalls(client: PoolClient, jobId: string, accountId: string): Promise<number> {
    const { rows } = await client.query<{ promote_calls: number }>(
      `UPDATE group_job_members
       SET promote_calls = promote_calls + 1
       WHERE job_id = $1 AND account_id = $2
       RETURNING promote_calls`,
      [jobId, accountId],
    );
    return rows[0]?.promote_calls ?? 0;
  }

  /** 追加 error（不置 failed；leave-all 中非群主失败时继续处理其余成员）。 */
  async appendError(client: PoolClient, jobId: string, err: JobError): Promise<void> {
    await client.query(
      `UPDATE jobs
       SET errors = errors || $1::jsonb, updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(err), jobId],
    );
  }

  /** 追加 error 并把 job 置为 failed。 */
  async appendErrorAndFail(client: PoolClient, jobId: string, err: JobError): Promise<void> {
    await client.query(
      `UPDATE jobs
       SET errors = errors || $1::jsonb, status = 'failed', updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(err), jobId],
    );
  }

  /** 把 job 置为 finished。 */
  async markFinished(client: PoolClient, jobId: string): Promise<void> {
    await client.query(
      `UPDATE jobs SET status = 'finished', updated_at = now() WHERE id = $1`,
      [jobId],
    );
  }

  /** 把邀请链接写入 payload（invite 步骤成功后持久化，重启恢复用）。 */
  async updateInvitePayload(client: PoolClient, jobId: string, invite: { inviteLink: string; inviteReadyAt: Date }): Promise<void> {
    await client.query(
      `UPDATE jobs
       SET payload = payload || $1::jsonb, updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(invite), jobId],
    );
  }

  /** 清除 payload 中的邀请信息（INVITE_EXPIRED 后重新申请）。 */
  async clearInvitePayload(client: PoolClient, jobId: string): Promise<void> {
    await client.query(
      `UPDATE jobs
       SET payload = payload - 'inviteLink' - 'inviteReadyAt', updated_at = now()
       WHERE id = $1`,
      [jobId],
    );
  }

  // -------------------------------------------------------------------------
  // B2：leave-all job
  // -------------------------------------------------------------------------

  /** 创建 leave-all job（事务内调用）。成员进度以 group_members 行为准，无需额外游标。 */
  async createLeaveAllJob(
    client: PoolClient,
    payload: { groupId: string; gatewayGroupId: string },
  ): Promise<string> {
    // leaveRetries：leave 遇 500 INTERNAL_ERROR 的跨 tick 重试计数（key=accountId）
    const fullPayload = { ...payload, leaveRetries: {} };
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO jobs (kind, status, payload)
       VALUES ('leave_all', 'running', $1::jsonb)
       RETURNING id`,
      [JSON.stringify(fullPayload)],
    );
    const jobId = rows[0]?.id;
    if (jobId === undefined) throw new Error('创建 leave-all job 失败');
    return jobId;
  }

  /** 取可执行的 leave_all job。 */
  async listRunnableLeaveAllJobs(limit = 10): Promise<JobRow[]> {
    const { rows } = await this.pool.query<DbJobRow>(
      `SELECT * FROM jobs
       WHERE kind = 'leave_all' AND status = 'running'
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map(fromDb);
  }

  /** 通用 payload 更新（leave-all 进度追踪用）。 */
  async mergePayload(client: PoolClient, jobId: string, patch: Record<string, unknown>): Promise<void> {
    await client.query(
      `UPDATE jobs
       SET payload = payload || $1::jsonb, updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(patch), jobId],
    );
  }
}
