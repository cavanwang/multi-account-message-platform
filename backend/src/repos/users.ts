/**
 * 控制台用户的仓储层：本切片只需要"按用户名查用户"。
 * SQL 只出现在 repos 层。
 */
import type { Pool } from 'pg';

export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: 'admin' | 'viewer';
}

interface DbUserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'viewer';
}

export class UserRepo {
  constructor(private readonly pool: Pool) {}

  /** 按用户名查用户；不存在返回 undefined。 */
  async findByUsername(username: string): Promise<UserRow | undefined> {
    return this.mapFirst(
      await this.pool.query<DbUserRow>(
        'SELECT id, username, password_hash, role FROM users WHERE username = $1',
        [username],
      ),
    );
  }

  /** 按 UUID 查用户（B3 refresh 时用 session.userId 反查）。 */
  async findById(id: string): Promise<UserRow | undefined> {
    return this.mapFirst(
      await this.pool.query<DbUserRow>(
        'SELECT id, username, password_hash, role FROM users WHERE id = $1',
        [id],
      ),
    );
  }

  private mapFirst(result: { rows: DbUserRow[] }): UserRow | undefined {
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
    };
  }
}
