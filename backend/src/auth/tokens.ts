/**
 * access token 的签发与校验（HS256 JWT）。
 *
 * 需求：access token 有效期 15 分钟（本实现可配，默认 900 秒）。
 * refresh token 属于 B3，切片 0 不实现。
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../config/env.js';

/** 令牌里携带的声明。role 用于鉴权/授权，sid 留给 B3 的会话撤销使用。 */
export interface AccessTokenClaims extends JWTPayload {
  /** 用户 ID（users.id） */
  sub: string;
  /** 用户名，便于日志与前端展示 */
  username: string;
  /** 角色：admin 全权限，viewer 只读 */
  role: 'admin' | 'viewer';
}

/** 已认证的请求主体，挂在请求对象上供路由使用。 */
export interface AuthPrincipal {
  readonly userId: string;
  readonly username: string;
  readonly role: 'admin' | 'viewer';
}

const ALGORITHM = 'HS256';

function secretKey(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

/** 为指定用户签发 access token。 */
export async function signAccessToken(
  config: AppConfig,
  principal: AuthPrincipal,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username: principal.username, role: principal.role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(principal.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + config.accessTokenTtlSeconds)
    .sign(secretKey(config));
}

/**
 * 校验 access token。
 * @returns 合法则返回主体信息；签名错误、过期、声明缺失一律抛错，由调用方转成 401。
 */
export async function verifyAccessToken(
  config: AppConfig,
  token: string,
): Promise<AuthPrincipal> {
  const { payload } = await jwtVerify(token, secretKey(config), { algorithms: [ALGORITHM] });
  const claims = payload as AccessTokenClaims;

  if (typeof claims.sub !== 'string' || typeof claims.username !== 'string') {
    throw new Error('token 缺少必要声明');
  }
  if (claims.role !== 'admin' && claims.role !== 'viewer') {
    throw new Error('token 的 role 非法');
  }

  return { userId: claims.sub, username: claims.username, role: claims.role };
}
