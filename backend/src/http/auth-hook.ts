/**
 * Fastify 的鉴权与授权钩子。
 *
 * 规则（需求 A0）：
 *  - 缺少 / 无效 / 过期的 Bearer token → 401 UNAUTHORIZED
 *  - viewer 对**所有写操作** → 403 FORBIDDEN
 *
 * 写操作的判定目前采用"HTTP 方法非 GET/HEAD/OPTIONS 即为写操作"。
 * TODO(B3/切片5)：如果将来出现语义上只读的 POST（例如 POST /api/auth/refresh 之外的
 * 查询类端点），需要改为在路由上显式声明 requiredRole，而不是依赖方法名推断。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { AppError } from './errors.js';
import { verifyAccessToken, type AuthPrincipal } from '../auth/tokens.js';
import { SessionRepo } from '../repos/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** 通过鉴权后填充；未鉴权的请求上为 undefined */
    principal?: AuthPrincipal;
  }
}

/** 视为只读的 HTTP 方法。 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** 鉴权 + 授权钩子，注册为全局 preHandler。 */
export function makeAuthHook(config: AppConfig, pool: Pool) {
  return async function authHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (token === undefined) {
      throw AppError.unauthorized('缺少 Authorization: Bearer <token> 请求头');
    }

    let principal: AuthPrincipal;
    try {
      principal = await verifyAccessToken(config, token);
    } catch {
      // 签名错误、过期、结构非法都归为 401，且不区分原因（避免泄露信息）
      throw AppError.unauthorized('access token 无效或已过期');
    }

    // B3：带 sid 的 token 必须对应一个有效（未吊销）的会话；logout 后立即失效
    if (principal.sessionId !== undefined) {
      const session = await new SessionRepo(pool).findById(principal.sessionId);
      if (session === undefined || session.revokedAt !== null) {
        throw AppError.unauthorized('会话已失效，请重新登录');
      }
    }

    request.principal = principal;

    // viewer 只读：任何非只读方法一律 403
    if (principal.role !== 'admin' && !READ_METHODS.has(request.method)) {
      throw AppError.forbidden('viewer 角色为只读，不能执行写操作');
    }
  };
}
