/**
 * 账号服务：编排状态转移 + 调用网关 + CAS 重试。
 *
 * 设计（规划 02 §3）：
 *  - 数据库的 accounts.status 是权威，状态转移合法性由 domain/account-fsm 判定
 *  - 只允许调用网关的**正式路径** connect / disconnect；严禁调用 /_mock/* 私有端点
 *    （网关侧的故障状态由测试脚本通过 /_mock 设置，后端只通过 429/401/403 或
 *    SSE 事件被动感知——见切片 3）
 *  - 操作员触发的终态转移只执行本地 markTerminal()，不调网关，
 *    避免"网关成功、本地失败"的跨系统分裂窗口
 *  - CAS 冲突时自动重试（最多 3 次），重试前重新读取当前状态并重新判定转移合法性
 *  - 普通转移成功后入队 account_status_changed；终态后果与 account_terminal
 *    由 account-terminal.ts 在同一事务内处理
 */
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { AccountRepo, type AccountRow } from '../repos/accounts.js';
import {
  assertCanTransition,
  isTerminal,
  type AccountStatus,
} from '../domain/account-fsm.js';
import { AppError } from '../http/errors.js';
import { markTerminal, type TerminalResult } from './account-terminal.js';
import { enqueueWebEvent } from '../repos/web-events.js';

/**
 * 网关客户端：只暴露题面定义的正式路径（§3.1–3.4）。
 * /_mock/* 是模拟器私有端点，后端不得依赖。
 */
export interface GatewayClient {
  connect(accountId: string): Promise<{ platformUserId: string }>;
  disconnect(accountId: string): Promise<void>;
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
   * connect：idle / disconnected / rate_limited → online，调网关 connect 拿 platformUserId。
   * 幂等：已在线返回现有 platformUserId；终态按状态返回 403/401，不做状态转移。
   */
  async connect(accountId: string): Promise<{ platformUserId: string }> {
    return this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) {
        throw terminalConnectError(accountId, account.status);
      }
      // 已在线：幂等返回，不算转移、不推事件
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
      await this.emitStatusChanged(accountId, account.status, 'online');
      return { platformUserId: updated.platformUserId! };
    });
  }

  /**
   * disconnect：online / rate_limited → disconnected，调网关 disconnect。
   * 幂等：已断开返回成功（不推事件）；终态抛 403/401。
   *
   * 注：规划 §3.4 要求网关调用失败时"不回滚状态、记 inconsistency"，
   * pending_reconciliations 表在切片 3 建立；在此之前维持 fail-closed（失败即报错）。
   */
  async disconnect(accountId: string): Promise<void> {
    await this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) {
        throw terminalConnectError(accountId, account.status);
      }
      if (account.status === 'disconnected') return true; // 幂等，不推事件

      assertCanTransition(account.status, 'disconnected');
      await this.gateway.disconnect(accountId);
      const updated = await this.repo.transitionCAS(accountId, account.version, 'disconnected');
      if (updated === null) return null;
      await this.emitStatusChanged(accountId, account.status, 'disconnected');
      return true;
    });
  }

  /**
   * goIdle：online / disconnected → idle。
   * - online → idle：先调网关 disconnect，再本地置 idle（规划 §3.4）
   * - disconnected → idle：纯本地转移（网关侧本就已断开）
   */
  async goIdle(accountId: string): Promise<void> {
    await this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) {
        throw terminalConnectError(accountId, account.status);
      }
      if (account.status === 'idle') return true; // 幂等（路由层通常已拦截同状态转移）

      assertCanTransition(account.status, 'idle');
      if (account.status === 'online') {
        // 与 disconnect 相同的副作用：网关侧断开连接
        await this.gateway.disconnect(accountId);
      }
      const updated = await this.repo.transitionCAS(accountId, account.version, 'idle');
      if (updated === null) return null;
      await this.emitStatusChanged(accountId, account.status, 'idle');
      return true;
    });
  }

  /**
   * 标记为限流：online → rate_limited。
   * 由切片 3 的出站 worker 在收到网关 429 响应后调用——网关侧已自行限流，
   * 这里只记录本地状态，不需要（也不允许）反向调用 /_mock。
   * 刷新 rateLimitedUntil 不推事件，仅 online → rate_limited 这一次推。
   */
  async markRateLimited(
    accountId: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    await this.withCASRetry(accountId, async (account) => {
      if (isTerminal(account.status)) return true; // 终态不再转移
      if (account.status === 'rate_limited') return true; // 幂等刷新，不推事件

      assertCanTransition(account.status, 'rate_limited');
      const rateLimitedUntil = new Date(Date.now() + retryAfterSeconds * 1000);
      const updated = await this.repo.transitionCAS(accountId, account.version, 'rate_limited', {
        rateLimitedUntil,
        retryAfterSeconds,
      });
      if (updated === null) return null;
      await this.emitStatusChanged(accountId, account.status, 'rate_limited');
      return true;
    });
  }

  /**
   * 操作员标记终态：只执行本地终态原子事务（markTerminal），不调网关。
   * 网关侧若也需要进入终态，由测试脚本调 /_mock 私有端点完成。
   */
  async suspend(accountId: string): Promise<TerminalResult> {
    return markTerminal(this.pool, accountId, 'suspended', 'operator');
  }

  async sessionExpire(accountId: string): Promise<TerminalResult> {
    return markTerminal(this.pool, accountId, 'session_expired', 'operator');
  }

  /**
   * 转移成功后入队 account_status_changed。
   * 状态已落库是权威；事件入队失败不反向影响转移结果（仅记录错误，
   * 前端可通过切片 4 的状态接口补偿）。
   */
  private async emitStatusChanged(
    accountId: string,
    from: AccountStatus,
    to: AccountStatus,
  ): Promise<void> {
    try {
      await enqueueWebEvent(this.pool, 'account_status_changed', { accountId, from, to });
    } catch (err) {
      console.error('[AccountService] account_status_changed 入队失败:', {
        accountId,
        from,
        to,
        err: err instanceof Error ? err.message : err,
      });
    }
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
        // 延迟重试，避免快速连续冲突
        // eslint-disable-next-line no-promise-executor-return
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
    throw new Error(`账号 ${accountId} CAS 冲突，重试 ${maxRetries} 次后仍失败`);
  }
}

/**
 * 终态账号尝试 connect/disconnect 时的错误：
 * 语义对齐网关——suspended → 403，session_expired → 401（规划 02 §3）。
 */
function terminalConnectError(accountId: string, status: AccountStatus): AppError {
  if (status === 'session_expired') {
    return AppError.unauthorized(`账号 ${accountId} 会话已失效（SESSION_EXPIRED），无法操作`);
  }
  return AppError.forbidden(`账号 ${accountId} 已被停用（ACCOUNT_SUSPENDED），无法操作`);
}
