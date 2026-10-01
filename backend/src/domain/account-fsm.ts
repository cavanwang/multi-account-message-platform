/**
 * 账号状态机（需求 §5 A1）。
 *
 * 职责：判定状态转移是否合法，**不执行副作用**（connect / disconnect / 调网关一律由 service 层做）。
 * 这样 domain 层可以被单元测试纯函数式地覆盖，不依赖数据库或网关。
 *
 * 状态图（6 态）：
 *
 *        idle ─────────connect────────► online ◄──────── disconnect ────── disconnected
 *         │                               │  ↑                               │
 *         │                          429  │  │ 到期/解除                      │
 *         │                               ↓  │                               │
 *         │                          rate_limited                             │
 *         │                               │                                  │
 *         └─────── suspended ◄────────────┼──────────────────────────────────┘
 *                 session_expired ◄───────┘
 *
 * 转移表（行=当前，列=目标；✔=合法）：
 *   | 从 \\ 到         | idle | online | rate_limited | disconnected | suspended | session_expired |
 *   |-----------------|------|--------|--------------|--------------|-----------|-----------------|
 *   | idle            |      |   ✔    |              |              |     ✔     |        ✔        |
 *   | online          |  ✔   |        |      ✔       |      ✔       |     ✔     |        ✔        |
 *   | rate_limited    |      |   ✔    |              |      ✔       |     ✔     |        ✔        |
 *   | disconnected    |  ✔   |   ✔    |              |              |     ✔     |        ✔        |
 *   | suspended       |      |        |              |              |           |                 |
 *   | session_expired |      |        |              |              |           |                 |
 *
 * 规则：
 *   - suspended / session_expired 是终态，无出边
 *   - 重复进入同一终态 → 静默忽略（不报错、不重复触发后果）
 *   - 表上没有的转移（包括同状态到同状态）→ ILLEGAL_TRANSITION
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

/** 所有合法状态值（用于校验）。 */
export const ALL_STATUSES: readonly AccountStatus[] = [
  'idle',
  'online',
  'disconnected',
  'rate_limited',
  'suspended',
  'session_expired',
];

export function isTerminal(status: AccountStatus): boolean {
  return TERMINAL_STATES.has(status);
}

export function isValidStatus(status: string): status is AccountStatus {
  return ALL_STATUSES.includes(status as AccountStatus);
}

/**
 * 合法转移表（不含终态出边）。
 * key = 当前状态，value = 可转入的目标状态集合。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AccountStatus, ReadonlySet<AccountStatus>>> = {
  idle: new Set(['online', 'suspended', 'session_expired']),
  online: new Set(['idle', 'disconnected', 'rate_limited', 'suspended', 'session_expired']),
  rate_limited: new Set(['online', 'disconnected', 'suspended', 'session_expired']),
  disconnected: new Set(['idle', 'online', 'suspended', 'session_expired']),
  suspended: new Set(), // 终态，无出边
  session_expired: new Set(), // 终态，无出边
};

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
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
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
