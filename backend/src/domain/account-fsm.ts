/**
 * 账号状态机（需求 §3）。
 *
 * 职责：判定状态转移是否合法，**不执行副作用**（connect / disconnect / 调网关一律由 service 层做）。
 * 这样 domain 层可以被单元测试纯函数式地覆盖，不依赖数据库或网关。
 *
 * 状态图：
 *
 *   idle ──connect──> online ──disconnect──> disconnected
 *                       │  ↑
 *                  429  │  │ 到期/解除
 *                       ↓  │
 *                  rate_limited
 *
 *   任意状态 ──终态触发──> suspended / session_expired（不可逆）
 *
 * 转移表：
 *   - idle → online: connect 成功
 *   - online → disconnected: 主动断开
 *   - online → rate_limited: 网关返回 429
 *   - rate_limited → online: 到期或人工解除
 *   - 任意状态 → suspended / session_expired: 终态，不可逆
 *   - 其余转移均非法，抛 ILLEGAL_TRANSITION
 */

export type AccountStatus =
  | 'idle'
  | 'online'
  | 'disconnected'
  | 'rate_limited'
  | 'suspended'
  | 'session_expired';

/** 终态：一旦进入就不可转出。 */
const TERMINAL_STATES: ReadonlySet<AccountStatus> = new Set(['suspended', 'session_expired']);

export function isTerminal(status: AccountStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/**
 * 判定从 from 转到 to 是否合法。
 * @returns {boolean} true 表示合法；false 表示非法（调用方据此抛 ILLEGAL_TRANSITION）
 */
export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  // 终态不可转出
  if (isTerminal(from)) return false;

  // 进入终态：任意非终态 → 终态都合法
  if (isTerminal(to)) return true;

  // 非终态之间的转移表
  const allowed: Record<AccountStatus, readonly AccountStatus[]> = {
    idle: ['online'],
    online: ['disconnected', 'rate_limited'],
    disconnected: [], // disconnected 只能进终态，或被人工改回 online（后者属于运维操作，暂不建模）
    rate_limited: ['online'],
    suspended: [],
    session_expired: [],
  };

  return allowed[from]?.includes(to) ?? false;
}

/**
 * 断言转移合法，否则抛错（供 service 层调用）。
 * @throws {Error} 非法转移时抛出，message 里包含 from / to
 */
export function assertCanTransition(from: AccountStatus, to: AccountStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态转移：${from} → ${to}`);
  }
}
