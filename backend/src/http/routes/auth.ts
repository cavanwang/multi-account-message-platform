/**
 * 认证端点（B3 登录会话）。
 *
 * POST /api/auth/login { username, password }
 *   → 200 { accessToken } + Set-Cookie: refresh_token（HttpOnly，不在响应体）
 *   凭证错误 → 401 UNAUTHORIZED（不区分"用户不存在"与"口令错误"）。
 *
 * POST /api/auth/refresh（读 cookie）
 *   → 200 { accessToken } + 新的 Set-Cookie（轮换）
 *   旧 refresh token 复用 → 401，且该用户整个会话（所有 session）作废，
 *   已换出的新 refresh token 与新 access token 立即失效。
 *
 * POST /api/auth/logout（读 cookie）
 *   → 204；吊销该 refresh token 的 session，同一 access token 立即失效（auth-hook 查 session）。
 *
 * 实现要点：
 *   - refresh token 明文只在 cookie 中，数据库只存 SHA-256 哈希；
 *   - 轮换 = 新建 session + 吊销旧 session，两步在同一事务内完成；
 *   - access token 携带 sid（session id），auth-hook 每次校验会话是否被吊销。
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../errors.js';
import { UserRepo } from '../../repos/users.js';
import { SessionRepo, hashRefreshToken } from '../../repos/sessions.js';
import { signAccessTokenWithSession } from '../../auth/tokens.js';

interface AuthDeps {
  readonly config: AppConfig;
  readonly pool: Pool;
}

const loginBodySchema = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

interface LoginBody {
  username: string;
  password: string;
}

/** refresh token cookie 名与属性。HttpOnly；Path 限定到 auth 端点。 */
const REFRESH_COOKIE = 'refresh_token';
const COOKIE_BASE = 'HttpOnly; Path=/api/auth; SameSite=Lax';

/** 从 Cookie 头解析 refresh token。 */
function readRefreshCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === REFRESH_COOKIE) {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function setRefreshCookie(reply: { header: (k: string, v: string) => unknown }, token: string): void {
  reply.header('set-cookie', `${REFRESH_COOKIE}=${token}; ${COOKIE_BASE}`);
}

function clearRefreshCookie(reply: { header: (k: string, v: string) => unknown }): void {
  reply.header('set-cookie', `${REFRESH_COOKIE}=; ${COOKIE_BASE}; Max-Age=0`);
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const users = new UserRepo(deps.pool);
  const sessions = new SessionRepo(deps.pool);
  const { pool, config } = deps;

  // ---- login：签发 access token + 创建 refresh session（cookie 下发）----
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    { schema: { body: loginBodySchema } },
    async (request, reply) => {
      const { username, password } = request.body;

      const user = await users.findByUsername(username);
      // 先占位比对，避免"用户不存在立即返回"造成的时序侧信道。
      const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
      const passwordOk = await bcrypt.compare(password, hash);

      if (user === undefined || !passwordOk) {
        throw AppError.unauthorized('用户名或密码错误');
      }

      // 事务内创建 refresh session（cookie 与 session 原子生效）
      const refreshToken = randomUUID();
      const client = await pool.connect();
      let sessionId: string;
      try {
        await client.query('BEGIN');
        sessionId = await sessions.createSession(client, user.id, refreshToken);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const accessToken = await signAccessTokenWithSession(
        config,
        { userId: user.id, username: user.username, role: user.role },
        sessionId,
      );

      setRefreshCookie(reply, refreshToken);
      request.log.info({ username: user.username, role: user.role, sessionId }, 'login succeeded');
      return reply.status(200).send({ accessToken });
    },
  );

  // ---- refresh：读 cookie → 轮换 → 新 access token + 新 cookie ----
  app.post('/api/auth/refresh', async (request, reply) => {
    const refreshToken = readRefreshCookie(request);
    if (refreshToken === undefined) {
      throw AppError.unauthorized('缺少 refresh token cookie');
    }

    // 明文 token 找到有效 session → 合法轮换
    const session = await sessions.findValidByToken(refreshToken);
    if (session === undefined) {
      // 找不到有效 session：可能是旧 token 复用（已轮换）或已吊销。
      // 只要哈希存在（无论是否 revoked），都视为复用攻击 → 吊销该用户全部 session。
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // 用哈希直接定位 owner（findValidByToken 查不到时也要知道是谁的 token）
        const stale = await client.query<{ user_id: string }>(
          'SELECT user_id FROM refresh_sessions WHERE token_hash = $1 LIMIT 1',
          [hashRefreshToken(refreshToken)],
        );
        if (stale.rows[0] !== undefined) {
          await sessions.revokeAllForUser(client, stale.rows[0].user_id);
          request.log.warn({ userId: stale.rows[0].user_id }, 'refresh token 复用，整个会话已作废');
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      clearRefreshCookie(reply);
      throw AppError.unauthorized('refresh token 无效或已过期');
    }

    const user = await users.findById(session.userId);
    if (user === undefined) {
      // session 存在但用户被删（极端），吊销全部 session
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await sessions.revokeAllForUser(client, session.userId);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      clearRefreshCookie(reply);
      throw AppError.unauthorized('refresh token 无效或已过期');
    }

    // 轮换：新 session + 吊销旧 session（同一事务）
    const newRefreshToken = randomUUID();
    const client = await pool.connect();
    let newSessionId: string;
    try {
      await client.query('BEGIN');
      newSessionId = await sessions.createSession(client, user.id, newRefreshToken);
      await sessions.revokeById(client, session.id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const accessToken = await signAccessTokenWithSession(
      config,
      { userId: user.id, username: user.username, role: user.role },
      newSessionId,
    );

    setRefreshCookie(reply, newRefreshToken);
    request.log.info({ username: user.username, sessionId: newSessionId }, 'refresh succeeded');
    return reply.status(200).send({ accessToken });
  });

  // ---- logout：吊销当前 session；同一 access token 立即失效 ----
  app.post('/api/auth/logout', async (request, reply) => {
    const refreshToken = readRefreshCookie(request);
    if (refreshToken === undefined) {
      throw AppError.unauthorized('缺少 refresh token cookie');
    }

    const session = await sessions.findValidByToken(refreshToken);
    if (session === undefined) {
      // token 无效/已吊销：幂等成功（logout 的语义是"确保不再有效"）
      clearRefreshCookie(reply);
      return reply.status(204).send();
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await sessions.revokeById(client, session.id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    clearRefreshCookie(reply);
    request.log.info({ sessionId: session.id }, 'logout succeeded');
    return reply.status(204).send();
  });
}
