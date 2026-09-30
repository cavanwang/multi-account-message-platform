/**
 * 账号服务：编排状态转移 + 调用网关 + CAS 重试。
 *
 * 设计：
 *  - 数据库的 accounts.status 是权威，状态转移逻辑在这里执行
 *  - 每次改状态后立即调对应的网关接口（connect / disconnect / /_mock/suspend 等）
 *  - 网关只是执行层，不反向通知后端
 *  - CAS 冲突时自动重试（最多 3 次），重试前重新读取当前状态并重新判定转移合法性
 */
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { AccountRepo, type AccountRow } from '../repos/accounts.js';
import { assertCanTransition, isTerminal, type AccountStatus } from '../domain/account-fsm.js';
import { AppError } from '../http/errors.js';

export interface GatewayClient {
  connect(accountId: string): Promise<{ platformUserId: string }>;
  disconnect(accountId: string): Promise<void>;
  suspend(accountId: string, opts?: { pushAccountStatus?: boolean }): Promise<void>;
  sessionExpire(accountId: string, opts?: { pushAccountStatus?: boolean }): Promise<void>;
  setRateLimit(accountId: string, retryAfterSeconds: number): Promise<void>;
}

export class AccountService {
  private readonly repo: AccountRepo;

  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly gateway: GatewayClient,
  ) {
    this.repo = new AccountRepo(pool);
  }

  async getByAccountId(accountId: string): Promise<AccountRow | undefined> {
    return this.repo.findByAccountId(accountId);
  }

  async list(): Promise<AccountRow[]> {
    return this.repo.list();
  }

  /**
   * connect：idle / disconnected → online，调网关 connect 拿 platformUserId。
   * 幂等：已在线返回现有 platformUserId；终态抛 403 FORBIDDEN。
   */
  async connect(accountId: string): Promise<{ platformUserId: string }> {
    return this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) {
        throw AppError.forbidden(`账号 ${accountId} 已进入终态 ${account.status}，无法 connect`);
      }
      // 已在线：幂等返回
      if (account.status === 'online') {
        if (account.platformUserId === null) {
          throw new Error(`账号 ${accountId} 状态为 online 但 platformUserId 为空，数据不一致`);
        }
        return { platformUserId: account.platformUserId };
      }

      assertCanTransition(account.status, 'online');
      const { platformUserId } = await this.gateway.connect(accountId);
      const updated = await this.repo.transitionCAS(accountId, account.version, 'online', {
        platformUserId,
      });
      if (updated === null) return null; // CAS 冲突，重试
      return { platformUserId: updated.platformUserId! };
    });
  }

  /**
   * disconnect：online → disconnected，调网关 disconnect。
   * 幂等：已断开返回成功；终态抛 403。
   */
  async disconnect(accountId: string): Promise<void> {
    return this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) {
        throw AppError.forbidden(`账号 ${accountId} 已进入终态 ${account.status}，无法 disconnect`);
      }
      if (account.status === 'disconnected') return {}; // 幂等

      assertCanTransition(account.status, 'disconnected');
      await this.gateway.disconnect(accountId);
      const updated = await this.repo.transitionCAS(accountId, account.version, 'disconnected');
      if (updated === null) return null;
      return {};
    });
  }

  /**
   * 标记为限流：online → rate_limited。
   * 场景：后端捕获网关的 429 响应后调此方法。
   */
  async markRateLimited(
    accountId: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    return this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) return {}; // 终态不再转移
      if (account.status === 'rate_limited') return {}; // 幂等

      assertCanTransition(account.status, 'rate_limited');
      await this.gateway.setRateLimit(accountId, retryAfterSeconds);
      const rateLimitedUntil = new Date(Date.now() + retryAfterSeconds * 1000);
      const updated = await this.repo.transitionCAS(accountId, account.version, 'rate_limited', {
        rateLimitedUntil,
        retryAfterSeconds,
      });
      if (updated === null) return null;
      return {};
    });
  }

  /**
   * 终态转移：任意状态 → suspended / session_expired。
   * 原子后果：调网关 /_mock 端点 → 网关移出所有群 + 推 member_left → 后端监听到后删成员。
   * 这里只做第一步，后续由事件消费者完成。
   */
  async suspend(accountId: string, opts: { pushAccountStatus?: boolean } = {}): Promise<void> {
    return this.markTerminal(accountId, 'suspended', opts);
  }

  async sessionExpire(accountId: string, opts: { pushAccountStatus?: boolean } = {}): Promise<void> {
    return this.markTerminal(accountId, 'session_expired', opts);
  }

  private async markTerminal(
    accountId: string,
    terminalStatus: 'suspended' | 'session_expired',
    opts: { pushAccountStatus?: boolean } = {},
  ): Promise<void> {
    return this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) {
        // 幂等：已是终态，确保网关侧也一致
        if (terminalStatus === 'suspended') {
          await this.gateway.suspend(accountId, opts);
        } else {
          await this.gateway.sessionExpire(accountId, opts);
        }
        return {};
      }

      assertCanTransition(account.status, terminalStatus);
      if (terminalStatus === 'suspended') {
        await this.gateway.suspend(accountId, opts);
      } else {
        await this.gateway.sessionExpire(accountId, opts);
      }
      const updated = await this.repo.transitionCAS(accountId, account.version, terminalStatus, {
        rateLimitedUntil: null,
        retryAfterSeconds: null,
      });
      if (updated === null) return null;
      return {};
    });
  }

  /**
   * CAS 重试框架：最多重试 3 次，每次重新读取并重新判定。
   * @param fn 返回 null 表示 CAS 冲突需要重试；返回其它值表示成功；抛错表示业务错误（不重试）
   */
  private async withCASRetry<T>(
    accountId: string,
    fn: (account: AccountRow) => Promise<T | null>,
  ): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const account = await this.repo.findByAccountId(accountId);
      if (account === undefined) {
        throw AppError.notFound(`账号 ${accountId} 不存在`);
      }

      try {
        const result = await fn(account);
        if (result !== null) return result;
        // CAS 冲突，重试
      } catch (err) {
        // 业务错误（AppError / 断言失败）不重试，直接抛出
        throw err;
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
    throw new Error(`账号 ${accountId} CAS 冲突，重试 ${maxRetries} 次后仍失败`);
  }
}
