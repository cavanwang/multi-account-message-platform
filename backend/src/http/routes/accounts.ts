/**
 * 账号相关路由：
 *   - GET  /api/accounts                - 列出所有账号
 *   - POST /api/accounts/:id/connect    - connect 账号（idle/disconnected → online）
 *   - POST /api/accounts/:id/transition - 手动状态转移（CAS + expectedFrom）
 *
 * 转移语义（规划 02 §3）：
 *   1. to / expectedFrom 必填且属于合法状态集，否则 400
 *   2. to === expectedFrom（自环）→ 409 ILLEGAL_TRANSITION
 *   3. rate_limited 只能由网关 429 进入，手动指定 → 400
 *   4. expectedFrom → to 不在转移表 → 409 ILLEGAL_TRANSITION
 *   5. 账号不存在 → 404；当前状态 ≠ expectedFrom → 409 CAS_CONFLICT（CAS 本身兜底）
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/env.js';
import { AppError, ErrorCode } from '../errors.js';
import { AccountService } from '../../services/accounts.js';
import { HttpAccountGateway } from '../../services/gateway-client.js';
import {
  canTransition,
  isValidStatus,
  type AccountStatus,
} from '../../domain/account-fsm.js';

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
  const gateway = new HttpAccountGateway(config.gatewayUrl);
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
      // 终态时 service 抛 401/403 AppError，由全局 errorHandler 统一序列化
      const result = await accountService.connect(accountId);
      return {
        status: 'online',
        platformUserId: result.platformUserId,
      };
    },
  );

  // POST /api/accounts/:id/transition - 手动状态转移
  app.post<{ Params: AccountParams; Body: TransitionBody }>(
    '/api/accounts/:id/transition',
    async (request: FastifyRequest<{ Params: AccountParams; Body: TransitionBody }>) => {
      const { id: accountId } = request.params;
      const body = request.body ?? {};

      // 1) 必填字段
      if (body.to === undefined || body.expectedFrom === undefined) {
        throw AppError.badRequest('缺少必填字段: to, expectedFrom');
      }
      const { to, expectedFrom } = body;

      // 2) 状态值合法性
      if (!isValidStatus(to)) {
        throw AppError.badRequest(`非法的目标状态: ${to}`);
      }
      if (!isValidStatus(expectedFrom)) {
        throw AppError.badRequest(`非法的当前状态: ${expectedFrom}`);
      }

      // 3) 自环（to === expectedFrom）非法：转移表没有任何同状态出边
      if (to === expectedFrom) {
        throw AppError.conflict(
          ErrorCode.ILLEGAL_TRANSITION,
          `非法状态转移：${expectedFrom} → ${to}（不允许转移到相同状态）`,
        );
      }

      // 4) rate_limited 只能由网关 429 触发，不接受操作员手动设置
      if (to === 'rate_limited') {
        throw AppError.badRequest('rate_limited 状态由网关 429 触发，不能手动设置');
      }

      // 5) 转移表判定
      if (!canTransition(expectedFrom, to)) {
        throw AppError.conflict(
          ErrorCode.ILLEGAL_TRANSITION,
          `非法状态转移：${expectedFrom} → ${to}`,
        );
      }

      // 6) 账号必须存在
      const account = await accountService.getByAccountId(accountId);
      if (account === undefined) {
        throw AppError.notFound(`账号 ${accountId} 不存在`);
      }

      // 7) expectedFrom 必须与当前状态一致（CAS version 更新是最终兜底）
      if (account.status !== expectedFrom) {
        throw AppError.conflict(
          ErrorCode.CAS_CONFLICT,
          `账号当前状态为 ${account.status}，不是预期的 ${expectedFrom}`,
        );
      }

      // 执行转移（service 内部负责网关副作用、CAS、事件入队）
      try {
        switch (to as AccountStatus) {
          case 'online':
            await accountService.connect(accountId);
            break;
          case 'disconnected':
            await accountService.disconnect(accountId);
            break;
          case 'idle':
            // online → idle 内部会调网关 disconnect；disconnected → idle 纯本地
            await accountService.goIdle(accountId);
            break;
          case 'suspended':
            await accountService.suspend(accountId);
            break;
          case 'session_expired':
            await accountService.sessionExpire(accountId);
            break;
          default:
            // rate_limited 已在上面拦截，其余合法值均已覆盖
            throw AppError.badRequest(`不支持的目标状态: ${to}`);
        }

        return { status: to };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof Error) {
          // CAS 重试耗尽期间状态漂移等兜底映射
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
