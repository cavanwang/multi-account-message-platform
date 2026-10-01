/**
 * 账号仓储层：SQL 只出现在这里。
 *
 * CAS 更新：每次状态转移时 version+1，WHERE 条件里带上旧 version，
 * 更新失败（rowCount=0）时抛 CAS_CONFLICT，由 service 层重试。
 */
import type { Pool } from 'pg';
import type { AccountStatus } from '../domain/account-fsm.js';

export interface AccountRow {
  readonly id: string;
  readonly accountId: string;
  readonly platformUserId: string | null;
  readonly status: AccountStatus;
  readonly rateLimitedUntil: Date | null;
  readonly retryAfterSeconds: number | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface DbAccountRow {
  id: string;
  account_id: string;
  platform_user_id: string | null;
  status: AccountStatus;
  rate_limited_until: Date | null;
  retry_after_seconds: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function fromDb(row: DbAccountRow): AccountRow {
  return {
    id: row.id,
    accountId: row.account_id,
    platformUserId: row.platform_user_id,
    status: row.status,
    rateLimitedUntil: row.rate_limited_until,
    retryAfterSeconds: row.retry_after_seconds,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AccountRepo {
  constructor(private readonly pool: Pool) {}

  async findByAccountId(accountId: string): Promise<AccountRow | undefined> {
    const { rows } = await this.pool.query<DbAccountRow>(
      'SELECT * FROM accounts WHERE account_id = $1',
      [accountId],
    );
    return rows[0] !== undefined ? fromDb(rows[0]) : undefined;
  }

  /**
   * 按文本 account_id 批量查询（建群受理的成员校验，避免 N+1 往返）。
   * 返回顺序不保证与入参一致，调用方需自行按入参顺序归并。
   */
  async findByAccountIds(accountIds: readonly string[]): Promise<AccountRow[]> {
    if (accountIds.length === 0) return [];
    const { rows } = await this.pool.query<DbAccountRow>(
      'SELECT * FROM accounts WHERE account_id = ANY($1)',
      [accountIds as string[]],
    );
    return rows.map(fromDb);
  }

  /**
   * 按平台用户 ID 反查账号（member_joined 事件：platformUserId → 服务账号）。
   * 外部用户无对应账号 → undefined。
   */
  async findByPlatformUserId(platformUserId: string): Promise<AccountRow | undefined> {
    const { rows } = await this.pool.query<DbAccountRow>(
      'SELECT * FROM accounts WHERE platform_user_id = $1',
      [platformUserId],
    );
    return rows[0] !== undefined ? fromDb(rows[0]) : undefined;
  }

  async list(): Promise<AccountRow[]> {
    const { rows } = await this.pool.query<DbAccountRow>('SELECT * FROM accounts ORDER BY account_id');
    return rows.map(fromDb);
  }

  /**
   * CAS 转移：改状态 + version+1，WHERE 条件带旧 version。
   * @returns 更新后的行；rowCount=0 时返回 null（表示 CAS 冲突或账号不存在）
   */
  async transitionCAS(
    accountId: string,
    expectedVersion: number,
    newStatus: AccountStatus,
    updates: {
      platformUserId?: string | null;
      rateLimitedUntil?: Date | null;
      retryAfterSeconds?: number | null;
    } = {},
  ): Promise<AccountRow | null> {
    const { rows, rowCount } = await this.pool.query<DbAccountRow>(
      `UPDATE accounts
       SET status = $1,
           platform_user_id = COALESCE($2, platform_user_id),
           rate_limited_until = COALESCE($3, rate_limited_until),
           retry_after_seconds = COALESCE($4, retry_after_seconds),
           version = version + 1,
           updated_at = now()
       WHERE account_id = $5 AND version = $6
       RETURNING *`,
      [
        newStatus,
        updates.platformUserId,
        updates.rateLimitedUntil,
        updates.retryAfterSeconds,
        accountId,
        expectedVersion,
      ],
    );
    // rowCount=0 表示 CAS 冲突或账号不存在；noUncheckedIndexedAccess 下
    // rows[0] 类型为 DbAccountRow | undefined，需显式收窄后再转换
    const updated = rows[0];
    if (rowCount === 0 || updated === undefined) return null;
    return fromDb(updated);
  }

  /**
   * 创建账号（幂等：已存在时返回现有记录）。
   * 预置账号通过 seed 迁移写入，这里只用于运行时动态添加（如果有这个需求）。
   */
  async upsert(accountId: string): Promise<AccountRow> {
    const { rows } = await this.pool.query<DbAccountRow>(
      `INSERT INTO accounts (account_id, status)
       VALUES ($1, 'idle')
       ON CONFLICT (account_id) DO NOTHING
       RETURNING *`,
      [accountId],
    );
    // 冲突时 RETURNING * 返回空，需要再查一次
    if (rows[0] !== undefined) return fromDb(rows[0]);
    const existing = await this.findByAccountId(accountId);
    if (existing === undefined) throw new Error(`账号 ${accountId} 创建失败且不存在`);
    return existing;
  }
}
