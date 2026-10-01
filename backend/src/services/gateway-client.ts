/**
 * 网关 HTTP 客户端：只封装题面正式路径，严禁调用 /_mock/*（模拟器私有端点）。
 *
 *  - HttpAccountGateway：connect / disconnect（账号路由与 AccountService 使用）
 *  - HttpSendGateway：POST /groups/:groupId/send（outbox-sender worker 使用）
 *  - HttpQueryGateway：by-client-id 查询（504 收敛 worker 使用）
 *  - HttpGroupGateway：createGroup / createInvite / join / promote（建群 job worker 使用）
 *
 * 设计原则：
 *  - 接口层（SendGateway / QueryGateway / GroupGateway）与 HTTP 实现分离，
 *    测试时可注入假网关；
 *  - 所有响应（成功/业务错误/网络异常）都收敛到类型安全的联合类型；
 *  - 网络异常（fetch 抛错）统一收敛为 503 SERVICE_UNAVAILABLE，
 *    由调用方决定重试策略，**不自动重发**（避免雪崩）。
 *
 * 日志：每次往返都输出结构化日志，携带关键 ID，便于串联排查。
 */
import type { GatewayClient } from './accounts.js';

/**
 * 最小日志接口：与 pino/ FastifyBaseLogger 结构兼容。
 * worker/service 不依赖具体 logger 类型，便于测试注入静默实现。
 */
export interface LoggerLike {
  debug(msg: string): void;
  debug(obj: object, msg?: string): void;
  info(msg: string): void;
  info(obj: object, msg?: string): void;
  warn(msg: string): void;
  warn(obj: object, msg?: string): void;
  error(msg: string): void;
  error(obj: object, msg?: string): void;
}

/** connect/disconnect 的 HTTP 实现（对应 accounts 路由中原 HttpGatewayClient）。 */
export class HttpAccountGateway implements GatewayClient {
  constructor(private readonly gatewayUrl: string) {}

  async connect(accountId: string): Promise<{ platformUserId: string }> {
    const res = await fetch(`${this.gatewayUrl}/accounts/${accountId}/connect`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`网关 connect 失败: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { platformUserId: string };
    return data;
  }

  async disconnect(accountId: string): Promise<void> {
    const res = await fetch(`${this.gatewayUrl}/accounts/${accountId}/disconnect`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`网关 disconnect 失败: ${res.status} ${body}`);
    }
  }
}

export interface SendGateway {
  send(
    gatewayGroupId: string,
    accountId: string,
    clientMsgId: string,
    text: string,
  ): Promise<SendResult>;
}

/** 网关 send 的响应联合类型。 */
export type SendResult =
  | { kind: 'accepted' }
  | { kind: 'error'; status: number; code: string; extra: Record<string, unknown> };

/** HTTP 实现：走 fetch 调网关正式端点。 */
export class HttpSendGateway implements SendGateway {
  constructor(
    private readonly gatewayUrl: string,
    private readonly log: LoggerLike,
  ) {}

  async send(
    gatewayGroupId: string,
    accountId: string,
    clientMsgId: string,
    text: string,
  ): Promise<SendResult> {
    const url = `${this.gatewayUrl}/groups/${encodeURIComponent(gatewayGroupId)}/send`;
    const logContext = { clientMsgId, gatewayGroupId, accountId, textLength: text.length };

    this.log.debug(logContext, 'gateway: 开始发送');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, clientMsgId, text }),
      });
    } catch (netErr) {
      // fetch 抛错 = 网络层不可达（DNS、TCP 断开、超时等）
      this.log.warn(
        { ...logContext, err: netErr instanceof Error ? netErr.message : String(netErr) },
        'gateway: 网络异常，收敛为 503',
      );
      return { kind: 'error', status: 503, code: 'SERVICE_UNAVAILABLE', extra: {} };
    }

    // 成功：202 accepted
    if (res.status === 202) {
      this.log.debug({ ...logContext, gatewayStatus: 202 }, 'gateway: 202 accepted');
      return { kind: 'accepted' };
    }

    // 业务错误：解析 { error: { code, ...extra } }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = {};
    }

    const bodyRecord = typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
    const errorRaw = bodyRecord['error'];
    const errorBody =
      typeof errorRaw === 'object' && errorRaw !== null
        ? (errorRaw as Record<string, unknown>)
        : {};

    const codeRaw = errorBody['code'];
    const code = typeof codeRaw === 'string' ? codeRaw : 'UNKNOWN_ERROR';
    const extra = { ...errorBody };
    delete extra['code']; // 剩余字段作为 extra

    this.log.warn(
      { ...logContext, gatewayStatus: res.status, gatewayCode: code, extra },
      'gateway: 业务错误',
    );

    return { kind: 'error', status: res.status, code, extra };
  }
}

/**
 * by-client-id 查询接口（504 收敛用，规划 03 §2.3）。
 * 返回消息是否已被网关持久化。
 */
export interface QueryGateway {
  byClientId(
    gatewayGroupId: string,
    clientMsgId: string,
  ): Promise<ByClientIdResult>;
}

export type ByClientIdResult =
  | { kind: 'found'; msgId: string; sentAt: string }
  | { kind: 'notFound' }
  | { kind: 'unavailable' };

/** HTTP 实现：GET /groups/:gid/messages/by-client-id/:cmid */
export class HttpQueryGateway implements QueryGateway {
  constructor(
    private readonly gatewayUrl: string,
    private readonly log: LoggerLike,
  ) {}

  async byClientId(
    gatewayGroupId: string,
    clientMsgId: string,
  ): Promise<ByClientIdResult> {
    const url = `${this.gatewayUrl}/groups/${encodeURIComponent(gatewayGroupId)}/messages/by-client-id/${encodeURIComponent(clientMsgId)}`;
    const logCtx = { clientMsgId, gatewayGroupId };

    let res: Response;
    try {
      res = await fetch(url);
    } catch (netErr) {
      this.log.warn(
        { ...logCtx, err: netErr instanceof Error ? netErr.message : String(netErr) },
        'gateway: by-client-id 网络异常，视为不可用',
      );
      return { kind: 'unavailable' };
    }

    if (res.status === 200) {
      const body = (await res.json()) as { msgId: string; sentAt: string };
      this.log.debug({ ...logCtx, msgId: body.msgId }, 'gateway: by-client-id 找到');
      return { kind: 'found', msgId: body.msgId, sentAt: body.sentAt };
    }
    if (res.status === 404) {
      this.log.debug(logCtx, 'gateway: by-client-id 未找到');
      return { kind: 'notFound' };
    }
    // 5xx / 其他：视为不可用
    this.log.warn(
      { ...logCtx, gatewayStatus: res.status },
      'gateway: by-client-id 不可用',
    );
    return { kind: 'unavailable' };
  }
}

// ---------------------------------------------------------------------------
// GroupGateway：建群 job 专用（createGroup / createInvite / join / promote）
// ---------------------------------------------------------------------------

/** 建群网关统一响应：成功 / 业务错误 / 网络异常。 */
export type GroupResult<T = void> =
  | { kind: 'ok'; data: T }
  | { kind: 'error'; status: number; code: string }
  | { kind: 'network'; status: number; code: string };

export interface GroupGateway {
  createGroup(creatorAccountId: string): Promise<GroupResult<{ groupId: string }>>;
  createInvite(
    gatewayGroupId: string,
    options?: { readyAfterMs?: number; ttlMs?: number },
  ): Promise<GroupResult<{ inviteLink: string; readyAfterMs: number }>>;
  join(
    gatewayGroupId: string,
    accountId: string,
    inviteLink: string,
  ): Promise<GroupResult>;
  promote(
    gatewayGroupId: string,
    byAccountId: string,
    accountId: string,
  ): Promise<GroupResult>;
  kickMember(
    gatewayGroupId: string,
    byAccountId: string,
    targetPlatformUserId: string,
  ): Promise<GroupResult>;
}

/** 提取 { error: { code } } 里的 code 字段。 */
function extractCode(body: unknown): string {
  if (typeof body !== 'object' || body === null) return 'UNKNOWN_ERROR';
  const err = (body as Record<string, unknown>)['error'];
  if (typeof err !== 'object' || err === null) return 'UNKNOWN_ERROR';
  return typeof (err as Record<string, unknown>)['code'] === 'string'
    ? ((err as Record<string, unknown>)['code'] as string)
    : 'UNKNOWN_ERROR';
}

/** HTTP 实现：建群相关端点。 */
export class HttpGroupGateway implements GroupGateway {
  constructor(
    private readonly gatewayUrl: string,
    private readonly log: LoggerLike,
  ) {}

  async createGroup(creatorAccountId: string): Promise<GroupResult<{ groupId: string }>> {
    const url = `${this.gatewayUrl}/groups`;
    const logCtx = { creatorAccountId };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorAccountId }),
      });
    } catch (netErr) {
      this.log.warn(
        { ...logCtx, err: netErr instanceof Error ? netErr.message : String(netErr) },
        'gateway: createGroup 网络异常',
      );
      return { kind: 'network', status: 503, code: 'SERVICE_UNAVAILABLE' };
    }

    if (res.status === 200) {
      const data = (await res.json()) as { groupId: string };
      this.log.debug({ ...logCtx, groupId: data.groupId }, 'gateway: createGroup 成功');
      return { kind: 'ok', data };
    }

    const code = extractCode(await res.json().catch(() => ({})));
    this.log.warn({ ...logCtx, status: res.status, code }, 'gateway: createGroup 业务错误');
    return { kind: 'error', status: res.status, code };
  }

  async createInvite(
    gatewayGroupId: string,
    options?: { readyAfterMs?: number; ttlMs?: number },
  ): Promise<GroupResult<{ inviteLink: string; readyAfterMs: number }>> {
    const url = `${this.gatewayUrl}/groups/${encodeURIComponent(gatewayGroupId)}/invite`;
    const logCtx = { gatewayGroupId };

    const body: Record<string, unknown> = {};
    if (typeof options?.readyAfterMs === 'number') body['readyAfterMs'] = options.readyAfterMs;
    if (typeof options?.ttlMs === 'number') body['ttlMs'] = options.ttlMs;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      this.log.warn(
        { ...logCtx, err: netErr instanceof Error ? netErr.message : String(netErr) },
        'gateway: createInvite 网络异常',
      );
      return { kind: 'network', status: 503, code: 'SERVICE_UNAVAILABLE' };
    }

    if (res.status === 200) {
      const data = (await res.json()) as { inviteLink: string; readyAfterMs: number };
      this.log.debug({ ...logCtx, inviteLink: data.inviteLink }, 'gateway: createInvite 成功');
      return { kind: 'ok', data };
    }

    const code = extractCode(await res.json().catch(() => ({})));
    this.log.warn({ ...logCtx, status: res.status, code }, 'gateway: createInvite 业务错误');
    return { kind: 'error', status: res.status, code };
  }

  async join(
    gatewayGroupId: string,
    accountId: string,
    inviteLink: string,
  ): Promise<GroupResult> {
    const url = `${this.gatewayUrl}/groups/${encodeURIComponent(gatewayGroupId)}/join`;
    const logCtx = { gatewayGroupId, accountId };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, inviteLink }),
      });
    } catch (netErr) {
      this.log.warn(
        { ...logCtx, err: netErr instanceof Error ? netErr.message : String(netErr) },
        'gateway: join 网络异常',
      );
      return { kind: 'network', status: 503, code: 'SERVICE_UNAVAILABLE' };
    }

    if (res.status === 202) {
      this.log.debug(logCtx, 'gateway: join 受理');
      return { kind: 'ok', data: undefined };
    }

    const code = extractCode(await res.json().catch(() => ({})));
    this.log.warn({ ...logCtx, status: res.status, code }, 'gateway: join 业务错误');
    return { kind: 'error', status: res.status, code };
  }

  async promote(
    gatewayGroupId: string,
    byAccountId: string,
    accountId: string,
  ): Promise<GroupResult> {
    const url = `${this.gatewayUrl}/groups/${encodeURIComponent(gatewayGroupId)}/promote`;
    const logCtx = { gatewayGroupId, byAccountId, accountId };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ byAccountId, accountId }),
      });
    } catch (netErr) {
      this.log.warn(
        { ...logCtx, err: netErr instanceof Error ? netErr.message : String(netErr) },
        'gateway: promote 网络异常',
      );
      return { kind: 'network', status: 503, code: 'SERVICE_UNAVAILABLE' };
    }

    if (res.status === 200) {
      this.log.debug(logCtx, 'gateway: promote 成功');
      return { kind: 'ok', data: undefined };
    }

    const code = extractCode(await res.json().catch(() => ({})));
    this.log.warn({ ...logCtx, status: res.status, code }, 'gateway: promote 业务错误');
    return { kind: 'error', status: res.status, code };
  }

  async kickMember(
    gatewayGroupId: string,
    byAccountId: string,
    targetPlatformUserId: string,
  ): Promise<GroupResult> {
    const url = `${this.gatewayUrl}/groups/${encodeURIComponent(gatewayGroupId)}/kick`;
    const logCtx = { gatewayGroupId, byAccountId, targetPlatformUserId };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ byAccountId, targetPlatformUserId }),
      });
    } catch (netErr) {
      this.log.warn(
        { ...logCtx, err: netErr instanceof Error ? netErr.message : String(netErr) },
        'gateway: kickMember 网络异常',
      );
      return { kind: 'network', status: 503, code: 'SERVICE_UNAVAILABLE' };
    }

    if (res.status === 200) {
      this.log.debug(logCtx, 'gateway: kickMember 成功');
      return { kind: 'ok', data: undefined };
    }

    const code = extractCode(await res.json().catch(() => ({})));
    this.log.warn({ ...logCtx, status: res.status, code }, 'gateway: kickMember 业务错误');
    return { kind: 'error', status: res.status, code };
  }
}
