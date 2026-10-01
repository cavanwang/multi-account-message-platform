/**
 * 账号相关路由：
 *   - GET /api/accounts - 列出所有账号
 *   - POST /api/accounts/:id/connect - connect 账号
 *   - POST /api/accounts/:id/transition - 手动状态转移
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/env.js';
import { AppError, ErrorCode } from '../errors.js';
import { AccountService, type GatewayClient } from '../../services/accounts.js';
import { isValidStatus, type AccountStatus } from '../../domain/account-fsm.js';

/** 简单的网关客户端实现（通过 HTTP 调用网关模拟器）。 */
class HttpGatewayClient implements GatewayClient {
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

  async suspend(accountId: string, opts: { pushAccountStatus?: boolean } = {}): Promise<void> {
    const res = await fetch(`${this.gatewayUrl}/_mock/accounts/${accountId}/suspend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushAccountStatus: opts.pushAccountStatus ?? true }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`网关 suspend 失败: ${res.status} ${body}`);
    }
  }

  async sessionExpire(accountId: string, opts: { pushAccountStatus?: boolean } = {}): Promise<void> {
    const res = await fetch(`${this.gatewayUrl}/_mock/accounts/${accountId}/session-expire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pushAccountStatus: opts.pushAccountStatus ?? true }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`网关 session-expire 失败: ${res.status} ${body}`);
    }
  }

  async setRateLimit(accountId: string, retryAfterSeconds: number): Promise<void> {
    const res = await fetch(`${this.gatewayUrl}/_mock/accounts/${accountId}/set-rate-limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retryAfterSeconds }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`网关 set-rate-limit 失败: ${res.status} ${body}`);
    }
  }
}

interface RouteDeps {
  config: AppConfig;
  pool: Pool;
}

interface AccountParams {
  id: string;
}

interface TransitionBody {
  to?: string;
  expectedFrom?: string;
}

export async function registerAccountRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { config, pool } = deps;
  const gateway = new HttpGatewayClient(config.gatewayUrl);
  const accountService = new AccountService(pool, config, gateway);

  // GET /api/accounts - 列出所有账号
  app.get('/api/accounts', async () => {
    const accounts = await accountService.list();
    return accounts.map((a) => ({
      id: a.accountId,
      status: a.status,
      platformUserId: a.platformUserId,
      rateLimitedUntil: a.rateLimitedUntil?.toISOString() ?? null,
    }));
  });

  // POST /api/accounts/:id/connect - connect 账号
  app.post<{ Params: AccountParams }>(
    '/api/accounts/:id/connect',
    async (request: FastifyRequest<{ Params: AccountParams }>) => {
      const { id: accountId } = request.params;
      try {
        const result = await accountService.connect(accountId);
        return {
          status: 'online',
          platformUserId: result.platformUserId,
        };
      } catch (err) {
        if (err instanceof Error && err.message.includes('终态')) {
          throw AppError.forbidden(err.message);
        }
        throw err;
      }
    },
  );

  // POST /api/accounts/:id/transition - 手动状态转移
  app.post<{ Params: AccountParams; Body: TransitionBody }>(
    '/api/accounts/:id/transition',
    async (request: FastifyRequest<{ Params: AccountParams; Body: TransitionBody }>) => {
      const { id: accountId } = request.params;
      const body = request.body;

      // 校验请求体
      if (body.to === undefined || body.expectedFrom === undefined) {
        throw AppError.badRequest('缺少必填字段: to, expectedFrom');
      }

      const { to, expectedFrom } = body;

      // 校验状态值合法性
      if (!isValidStatus(to)) {
        throw AppError.badRequest(`非法的目标状态: ${to}`);
      }
      if (!isValidStatus(expectedFrom)) {
        throw AppError.badRequest(`非法的当前状态: ${expectedFrom}`);
      }

      // 获取当前账号
      const account = await accountService.getByAccountId(accountId);
      if (account === undefined) {
        throw AppError.notFound(`账号 ${accountId} 不存在`);
      }

      // 校验 expectedFrom 是否匹配
      if (account.status !== expectedFrom) {
        throw AppError.conflict(
          ErrorCode.CAS_CONFLICT,
          `账号当前状态为 ${account.status}，不是预期的 ${expectedFrom}`,
        );
      }

      // 执行转移
      try {
        let newStatus: AccountStatus;

        switch (to) {
          case 'online':
            // 如果已在线，幂等返回
            if (account.status === 'online') {
              return { status: 'online' };
            }
            await accountService.connect(accountId);
            newStatus = 'online';
            break;

          case 'disconnected':
            await accountService.disconnect(accountId);
            newStatus = 'disconnected';
            break;

          case 'idle':
            // idle 需要通过 disconnect 实现（如果当前是 online）
            if (account.status === 'online' || account.status === 'rate_limited') {
              await accountService.disconnect(accountId);
            }
            // TODO: 如果需要直接设置为 idle，需要添加专门的转移方法
            newStatus = 'idle';
            break;

          case 'suspended':
            await accountService.suspend(accountId);
            newStatus = 'suspended';
            break;

          case 'session_expired':
            await accountService.sessionExpire(accountId);
            newStatus = 'session_expired';
            break;

          case 'rate_limited':
            // rate_limited 通常由网关 429 触发，手动设置需要 retryAfterSeconds
            throw AppError.badRequest('rate_limited 状态不能手动设置，由网关 429 触发');

          default:
            throw AppError.badRequest(`不支持的目标状态: ${to}`);
        }

        return { status: newStatus };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof Error) {
          if (err.message.includes('非法状态转移')) {
            throw AppError.conflict(ErrorCode.ILLEGAL_TRANSITION, err.message);
          }
          if (err.message.includes('CAS')) {
            throw AppError.conflict(ErrorCode.CAS_CONFLICT, '并发冲突，请重试');
          }
        }
        throw err;
      }
    },
  );
}
