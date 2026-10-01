/**
 * 通用故障注入注册表（`POST /_mock/faults` 的后端）。
 *
 * 设计原则（规划 01 §6：行为必须确定、可控）：
 *  - 所有故障默认关闭，必须通过 /_mock/faults 显式打开；
 *  - 规则按"逻辑端点"匹配（send / by-client-id / * ...），而非正则，
 *    避免测试脚本与路由实现耦合；
 *  - persist 规则持续到显式清除；非 persist 规则按 count（默认 1）消耗；
 *  - 只拦截题面 REST 契约端点；SSE /events、/health、/_mock/* 永不受影响。
 */

/** 可注入故障的逻辑端点集合。`*` 匹配全部 REST 端点。 */
export type FaultEndpoint =
  | '*'
  | 'connect'
  | 'disconnect'
  | 'create-group'
  | 'invite'
  | 'join'
  | 'promote'
  | 'kick'
  | 'leave'
  | 'members'
  | 'send'
  | 'by-client-id';

/** 故障模式：整体不可用 / 网络超时 / 纯延迟。 */
export type FaultMode = '503' | '504' | 'delay' | 'off';

/** 一条生效中的故障规则。 */
export interface FaultRule {
  readonly endpoint: FaultEndpoint;
  readonly mode: FaultMode;
  /** true：持续生效直到清除；false：命中 count 次后自动移除。 */
  readonly persist: boolean;
  /** 非 persist 时剩余可命中次数。 */
  remaining: number;
  /** 每次请求独立判定的命中概率（0–1]，默认 1。 */
  readonly probability: number;
  /** mode=delay 时的延迟毫秒数。 */
  readonly delayMs: number;
  /**
   * mode=504 且 endpoint=send 专用：504 返回后，延迟多少毫秒让消息"其实落地"。
   * 0 表示真的没有被网关接收（by-client-id 持续 404）。
   */
  readonly landAfterMs: number;
}

/** 规则按端点索引（同一端点后注册的规则覆盖先前的，语义简单确定）。 */
const rules = new Map<FaultEndpoint, FaultRule>();

const ALL_ENDPOINTS: readonly FaultEndpoint[] = [
  'connect',
  'disconnect',
  'create-group',
  'invite',
  'join',
  'promote',
  'kick',
  'leave',
  'members',
  'send',
  'by-client-id',
];

/**
 * 把 (method, path) 归类为逻辑端点；非契约路径返回 null。
 * 与 routes.ts 的路由正则保持同一套路径形状。
 */
export function classifyEndpoint(method: string, path: string): FaultEndpoint | null {
  // POST /accounts/:id/connect · /disconnect
  let m = /^\/accounts\/[^/]+\/(connect|disconnect)$/.exec(path);
  if (m && method === 'POST') return m[1] as FaultEndpoint;

  // POST /groups（建群）
  if (path === '/groups' && method === 'POST') return 'create-group';

  // POST /groups/:id/invite · /join · /promote · /kick · /leave · /send
  m = /^\/groups\/[^/]+\/(invite|join|promote|kick|leave|send)$/.exec(path);
  if (m && method === 'POST') return m[1] as FaultEndpoint;

  // GET /groups/:id/members
  m = /^\/groups\/[^/]+\/members$/.exec(path);
  if (m && method === 'GET') return 'members';

  // GET /groups/:id/messages/by-client-id/:clientMsgId
  m = /^\/groups\/[^/]+\/messages\/by-client-id\/[^/]+$/.exec(path);
  if (m && method === 'GET') return 'by-client-id';

  return null;
}

/**
 * 安装 / 更新一条故障规则。mode='off' 等价于清除该端点的规则。
 */
export function setFault(input: {
  endpoint: string;
  mode: string;
  persist?: boolean | undefined;
  count?: number | undefined;
  probability?: number | undefined;
  delayMs?: number | undefined;
  landAfterMs?: number | undefined;
}): FaultRule {
  if (!isFaultEndpoint(input.endpoint)) {
    throw new Error(`未知端点：${input.endpoint}`);
  }
  if (input.mode !== '503' && input.mode !== '504' && input.mode !== 'delay' && input.mode !== 'off') {
    throw new Error(`未知故障模式：${input.mode}`);
  }
  if (input.mode === 'off') {
    rules.delete(input.endpoint);
    return {
      endpoint: input.endpoint,
      mode: 'off',
      persist: false,
      remaining: 0,
      probability: 0,
      delayMs: 0,
      landAfterMs: 0,
    };
  }

  const probability = input.probability ?? 1;
  if (!(probability > 0 && probability <= 1)) {
    throw new Error('probability 必须在 (0, 1] 区间');
  }
  const persist = input.persist ?? false;
  const count = input.count ?? 1;
  if (!persist && (!Number.isInteger(count) || count < 1)) {
    throw new Error('非 persist 规则的 count 必须是 >= 1 的整数');
  }
  const delayMs = input.delayMs ?? 0;
  if (input.mode === 'delay' && delayMs < 0) {
    throw new Error('delayMs 不能为负');
  }
  const landAfterMs = input.landAfterMs ?? 0;
  if (landAfterMs < 0) {
    throw new Error('landAfterMs 不能为负');
  }

  const rule: FaultRule = {
    endpoint: input.endpoint,
    mode: input.mode,
    persist,
    remaining: persist ? Number.POSITIVE_INFINITY : count,
    probability,
    delayMs,
    landAfterMs,
  };
  rules.set(input.endpoint, rule);
  return rule;
}

/** 清除单个端点的规则。 */
export function clearFault(endpoint: string): boolean {
  if (!isFaultEndpoint(endpoint)) throw new Error(`未知端点：${endpoint}`);
  return rules.delete(endpoint);
}

/** 清空全部规则（/_mock/reset 调用）。 */
export function resetFaults(): void {
  rules.clear();
}

/** 导出当前规则（/_mock/state 断言用；Infinity 序列化为 'persist'）。 */
export function listFaults(): Array<Omit<FaultRule, 'remaining'> & { remaining: number | 'persist' }> {
  return [...rules.values()].map((r) => ({
    ...r,
    remaining: r.persist ? 'persist' : r.remaining,
  }));
}

/**
 * 只查看某端点当前规则而不消耗次数。
 * 用途：send 的 504 必须在读完请求体后由路由层处理（可能要延迟落地），
 * HTTP 守卫需要先据此决定"放行给路由"而不提前消耗规则。
 */
export function peekFault(endpoint: FaultEndpoint): FaultRule | null {
  return rules.get(endpoint) ?? rules.get('*') ?? null;
}

/**
 * 消耗并返回某端点当前应生效的故障（不区分模式时的统一入口）。
 * 优先返回端点专属规则，其次是 '*' 全局规则。
 * 概率未命中也会消耗次数（行为确定：次数是"判定次数"而非"生效次数"）。
 */
export function consumeFault(endpoint: FaultEndpoint): FaultRule | null {
  const direct = rules.get(endpoint);
  const wildcard = rules.get('*');
  const rule = direct ?? wildcard ?? null;
  if (rule === null) return null;

  const hit = Math.random() < rule.probability;
  if (!rule.persist) {
    rule.remaining -= 1;
    if (rule.remaining <= 0) rules.delete(rule.endpoint);
  }
  return hit ? rule : null;
}

function isFaultEndpoint(value: string): value is FaultEndpoint {
  return value === '*' || (ALL_ENDPOINTS as readonly string[]).includes(value);
}
