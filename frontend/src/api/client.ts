/**
 * API 客户端（B3 前端部分）：
 *   - 所有请求走同源相对路径（开发由 Vite proxy、生产由 nginx 反代到后端，无需 CORS）
 *   - access token 只保存在内存（模块级变量），刷新页面后通过 refresh cookie 换新 token
 *   - 401 时自动调 POST /api/auth/refresh 续期并重放原请求；
 *     多个请求并发遇到 401 时只发一次 refresh（single-flight）
 *   - refresh 失败（会话作废/过期）→ 清空会话并跳转登录页
 */

/** 后端统一错误形状：{ error: { code, message, requestId, ... } } */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    [key: string]: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody | null;

  constructor(status: number, code: string, message: string, body: ApiErrorBody | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 当前登录用户信息（从 access token 的 JWT payload 解出）。 */
export interface SessionInfo {
  username: string;
  role: 'admin' | 'viewer';
}

// ---- 模块级会话状态（内存；不入 localStorage，避免 XSS 窃取后持久化）----
let accessToken: string | null = null;
let sessionInfo: SessionInfo | null = null;

/** 会话被强制失效时的回调（由 App 注入：跳转登录页并提示）。 */
let onSessionExpired: (() => void) | null = null;
export function setOnSessionExpired(cb: (() => void) | null): void {
  onSessionExpired = cb;
}

export function getSessionInfo(): SessionInfo | null {
  return sessionInfo;
}

/** 当前内存中的 access token（供 WebSocket auth 帧使用）。 */
export function getAccessToken(): string | null {
  return accessToken;
}

/** 解析 JWT payload（不验签——验签是后端的事，前端只是取 role 做按钮显隐）。 */
function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64
    const b64 = (parts[1] as string).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function applyAccessToken(token: string): void {
  accessToken = token;
  const payload = parseJwtPayload(token);
  const role = payload?.['role'];
  const username = payload?.['username'];
  sessionInfo =
    typeof username === 'string' && (role === 'admin' || role === 'viewer')
      ? { username, role }
      : null;
}

function clearSession(): void {
  accessToken = null;
  sessionInfo = null;
}

// ---- single-flight refresh：并发 401 共用同一个进行中的 refresh Promise ----
let refreshInFlight: Promise<boolean> | null = null;

/**
 * 调 POST /api/auth/refresh（浏览器自动带 HttpOnly cookie）。
 * 成功 → 更新内存中的 access token，返回 true；失败 → 清空会话返回 false。
 * 并发的调用共享同一次请求。
 */
function refreshOnce(): Promise<boolean> {
  if (refreshInFlight !== null) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken?: unknown };
      if (typeof data.accessToken !== 'string') return false;
      applyAccessToken(data.accessToken);
      return true;
    } catch {
      return false;
    }
  })();

  // 无论成败，结束后释放 in-flight 引用，允许下一次 refresh
  void refreshInFlight.finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/**
 * 受保护 API 请求：自动带 Authorization 头；401 时 single-flight refresh 并重放一次。
 * refresh 也失败 → 触发 onSessionExpired（跳登录页）并抛 401 ApiError。
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (accessToken !== null) headers['Authorization'] = `Bearer ${accessToken}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  };

  let res = await doFetch();

  // access token 过期 → 续期一次并重放原请求（cookie 由浏览器自动携带）
  if (res.status === 401 && accessToken !== null) {
    const ok = await refreshOnce();
    if (ok) {
      res = await doFetch();
    } else {
      clearSession();
      onSessionExpired?.();
      throw new ApiError(401, 'UNAUTHORIZED', '会话已失效，请重新登录', null);
    }
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // 非 JSON 错误体（如网关 502 页面），body 保持 null
    }
    throw new ApiError(
      res.status,
      body?.error.code ?? `HTTP_${res.status}`,
      body?.error.message ?? `请求失败（HTTP ${res.status}）`,
      body,
    );
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 登录：成功返回用户信息；失败抛 ApiError。 */
export async function login(username: string, password: string): Promise<SessionInfo> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let message = `登录失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error.message;
    } catch {
      // 保留默认 message
    }
    throw new ApiError(res.status, 'UNAUTHORIZED', message, null);
  }
  const data = (await res.json()) as { accessToken: string };
  applyAccessToken(data.accessToken);
  // applyAccessToken 成功时 sessionInfo 必非空（payload 由后端签发，必带 username/role）
  return sessionInfo ?? { username, role: 'viewer' };
}

/** 登出：吊销后端 session（cookie），清空本地状态。 */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    clearSession();
  }
}

/**
 * 应用启动时尝试用 refresh cookie 恢复会话（刷新页面不掉线）。
 * 返回是否恢复成功。
 */
export async function restoreSession(): Promise<boolean> {
  return refreshOnce();
}
