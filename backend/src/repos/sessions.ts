/**
 * refresh token 会话仓储层（B3 登录会话）。
 *
 * 设计原则：
 *   - token 明文只存在于客户端 cookie，数据库里存 SHA-256 哈希；
 *   - 每次 refresh 创建新 session，旧 session 置 revoked_at；
 *   - 旧的 refresh token 被复用时 → 吊销该 user_id 下**所有** session（包括已轮换出去的新 token），
 *     实现"整个会话作废"。
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface DbSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function fromDb(row: DbSessionRow): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function sha256(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/** 供路由层做"按明文 token 反查"用（例如检测旧 token 复用）。 */
export function hashRefreshToken(plain: string): string {
  return sha256(plain);
}

export class SessionRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * 创建新 session。
   * @param token 明文 refresh token（外部用 crypto.randomUUID 生成）
   * @param ttlMinutes refresh token 有效期（分钟），默认 7 天
   */
  async createSession(
    client: PoolClient,
    userId: string,
    token: string,
    ttlMinutes = 10_080, // 7 天
  ): Promise<string> {
    const tokenHash = sha256(token);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO refresh_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '${ttlMinutes} minutes')
       RETURNING id`,
      [userId, tokenHash],
    );
    return rows[0]!.id;
  }

  /** 按明文 token 查找有效 session（未吊销且未过期）。 */
  async findValidByToken(token: string): Promise<SessionRow | undefined> {
    const tokenHash = sha256(token);
    const { rows } = await this.pool.query<DbSessionRow>(
      `SELECT * FROM refresh_sessions
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > now()
       LIMIT 1`,
      [tokenHash],
    );
    return rows[0] !== undefined ? fromDb(rows[0]) : undefined;
  }

  /** 按 session id 查（access token 的 sid 校验用）。 */
  async findById(sessionId: string): Promise<SessionRow | undefined> {
    const { rows } = await this.pool.query<DbSessionRow>(
      'SELECT * FROM refresh_sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0] !== undefined ? fromDb(rows[0]) : undefined;
  }

  /** 吊销指定 session。 */
  async revokeById(client: PoolClient, sessionId: string): Promise<void> {
    await client.query(
      `UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1`,
      [sessionId],
    );
  }

  /**
   * 吊销某用户下**所有** session（旧 refresh token 复用时触发整个会话作废）。
   */
  async revokeAllForUser(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE refresh_sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
}
