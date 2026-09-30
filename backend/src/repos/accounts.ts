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
    return rowCount === 0 ? null : fromDb(rows[0]);
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

  /**
   * 清除过期的限流状态：rate_limited_until < now() 的账号改回 online（网关侧也会自动恢复）。
   * 返回恢复的账号数。后台 sweep 定期调用。
   */
  async sweepExpiredRateLimits(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE accounts
       SET status = 'online', rate_limited_until = NULL, retry_after_seconds = NULL, version = version + 1, updated_at = now()
       WHERE status = 'rate_limited' AND rate_limited_until < now()`,
    );
    return rowCount ?? 0;
  }
}
