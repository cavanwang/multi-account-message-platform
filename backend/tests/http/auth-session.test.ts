/**
 * B3 登录会话测试：refresh token 轮换 / 复用作废 / logout 立即失效。
 *
 * 覆盖：
 *  - login：200 { accessToken } + HttpOnly refresh_token cookie（响应体不含 refresh token）
 *  - refresh：读 cookie → 新 accessToken + 新 cookie（轮换）
 *  - 旧 refresh token 复用 → 401，且整个会话作废：
 *      已换出的新 refresh token、新 access token 都立即失效
 *  - logout：204；同一 access token 立即失效；refresh cookie 也失效
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { pool, resetDb } from '../helpers/db.js';

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test',
    GATEWAY_URL: 'http://127.0.0.1:1',
    AGENT_URL: 'http://127.0.0.1:1',
    JWT_SECRET: 'test-secret-test-secret',
    LOG_LEVEL: 'fatal',
  });
  app = await buildServer({ config, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
});

function extractRefreshCookie(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw as string];
  for (const c of list) {
    const first = c.split(';')[0]!;
    const eq = first.indexOf('=');
    if (first.slice(0, eq).trim() === 'refresh_token') {
      return first.slice(eq + 1).trim();
    }
  }
  return undefined;
}

async function login(username = 'admin', password = 'admin') {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
}

async function refresh(cookieValue: string | undefined) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: cookieValue === undefined ? {} : { cookie: `refresh_token=${cookieValue}` },
  });
}

async function logout(cookieValue: string | undefined) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: cookieValue === undefined ? {} : { cookie: `refresh_token=${cookieValue}` },
  });
}

async function getGroups(accessToken: string) {
  return app.inject({
    method: 'GET',
    url: '/api/groups',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

describe('B3 登录会话', () => {
  it('login：返回 accessToken + HttpOnly refresh cookie，响应体不含 refresh token', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body['accessToken']).toBe('string');
    expect(body['refreshToken']).toBeUndefined();

    const cookie = extractRefreshCookie(res);
    expect(cookie).toBeDefined();
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain('HttpOnly');
  });

  it('login 后的 access token 可访问受保护路由', async () => {
    const res = await login();
    const { accessToken } = res.json() as { accessToken: string };
    const api = await getGroups(accessToken);
    expect(api.statusCode).toBe(200);
  });

  it('refresh：轮换出新的 accessToken 与 refresh cookie', async () => {
    const loginRes = await login();
    const oldCookie = extractRefreshCookie(loginRes);

    const res = await refresh(oldCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string };
    expect(typeof body.accessToken).toBe('string');

    const newCookie = extractRefreshCookie(res);
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toBe(oldCookie);

    // 新 access token 可用
    const api = await getGroups(body.accessToken);
    expect(api.statusCode).toBe(200);
  });

  it('旧 refresh token 复用 → 401，且整个会话作废（新 refresh/access 都失效）', async () => {
    const loginRes = await login();
    const oldCookie = extractRefreshCookie(loginRes);

    // 第一次 refresh：正常轮换
    const refreshRes = await refresh(oldCookie);
    expect(refreshRes.statusCode).toBe(200);
    const newCookie = extractRefreshCookie(refreshRes);
    const newAccess = (refreshRes.json() as { accessToken: string }).accessToken;

    // 旧 token 复用 → 401
    const reuseRes = await refresh(oldCookie);
    expect(reuseRes.statusCode).toBe(401);

    // 整个会话作废：新 refresh token 也失效
    const reuseNew = await refresh(newCookie);
    expect(reuseNew.statusCode).toBe(401);

    // 已换出的新 access token 立即失效
    const api = await getGroups(newAccess);
    expect(api.statusCode).toBe(401);
  });

  it('logout：204，同一 access token 立即失效，refresh cookie 失效', async () => {
    const loginRes = await login();
    const cookie = extractRefreshCookie(loginRes);
    const { accessToken } = loginRes.json() as { accessToken: string };

    const out = await logout(cookie);
    expect(out.statusCode).toBe(204);

    // 同一 access token 立即失效
    const api = await getGroups(accessToken);
    expect(api.statusCode).toBe(401);

    // refresh cookie 也失效
    const refreshRes = await refresh(cookie);
    expect(refreshRes.statusCode).toBe(401);
  });

  it('refresh 无 cookie → 401；logout 幂等（无效 token 也返回 204）', async () => {
    const noCookie = await refresh(undefined);
    expect(noCookie.statusCode).toBe(401);

    const badCookie = await refresh('not-a-real-token');
    expect(badCookie.statusCode).toBe(401);

    const out = await logout('not-a-real-token');
    expect(out.statusCode).toBe(204);
  });
});
