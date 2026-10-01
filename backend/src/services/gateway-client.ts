/**
 * 网关 HTTP 客户端：只封装题面正式路径，严禁调用 /_mock/*（模拟器私有端点）。
 *
 *  - HttpAccountGateway：connect / disconnect（账号路由与 AccountService 使用）
 *  - HttpSendGateway：POST /groups/:groupId/send（outbox-sender worker 使用）
 *
 * 设计原则：
 *  - 接口层（SendGateway）与 HTTP 实现分离，测试时可注入假网关；
 *  - send 的所有响应（成功/业务错误/网络异常）都收敛到类型安全的 SendResult；
 *  - 网络异常（fetch 抛错）统一收敛为 503 SERVICE_UNAVAILABLE，
 *    由调用方（outbox-sender）退避重试，**不自动重发**（避免雪崩）。
 *
 * 日志：每条发送/响应都输出结构化日志，携带 { clientMsgId, groupId, accountId,
 * gatewayStatus, gatewayCode }，便于按 ID 串联排查。
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
