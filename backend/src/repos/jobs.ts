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
 * 本批次（4.1/4.2/4.7）只实现"创建 + 查询"；worker 推进方法随批次 2（任务 4.3-4.6）补充。
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

interface DbJobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  errors: JobError[];
  created_at: Date;
  updated_at: Date;
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
}
