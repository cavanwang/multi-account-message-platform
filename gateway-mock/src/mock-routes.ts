/**
 * 控制端点（模拟器私有，前缀 /_mock/）。
 *
 * 这些端点**不属于题面定义的网关契约**，仅供测试驱动程序复现故障场景
 * （S1-S8 及后端自测）。后端代码不应依赖它们——code review 时需检查。
 *
 * 全部 POST 端点返回 { ok: true, ... }。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  behavior,
  dumpState,
  externalJoin,
  externalLeave,
  listAccounts,
  markAccountTerminal,
  ownerLeave,
  resetState,
  setRateLimit,
  setWriteForbidden,
  dissolveGroup,
  armKickTimeout,
  reinjectMessages,
  seedAccounts,
  getAccount,
} from './store.js';
import { sendError, sendJson, readJsonBody, activeConnectionCount } from './lib/http.js';
import * as bus from './lib/event-bus.js';
import { setTimingProfile, TIMING_PROFILES, currentTimingProfile } from './lib/timing.js';
import { setFault, clearFault, resetFaults, listFaults } from './lib/faults.js';
import { config } from './config.js';
import type { ReinjectEntry } from './types.js';

/**
 * 处理一个控制请求。
 * @returns 是否已处理
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // --- 只读查询 ---
  if (method === 'GET' && path === '/_mock/state') {
    sendJson(res, 200, {
      ...dumpState(),
      lastEventId: bus.lastEventId(),
      delivery: bus.deliveryFlags(),
      behavior: { ...behavior },
      faults: listFaults(),
      timingProfile: currentTimingProfile(),
      sseConnections: activeConnectionCount(),
    });
    return true;
  }

  if (method === 'GET' && path === '/_mock/accounts') {
    sendJson(res, 200, { accounts: listAccounts() });
    return true;
  }

  if (method !== 'POST') return false;

  // --- 账号状态 ---
  let m = /^\/_mock\/accounts\/([^/]+)\/(suspend|session-expire)$/.exec(path);
  if (m) {
    const accountId = decodeURIComponent(m[1]!);
    const to: 'suspended' | 'session_expired' =
      m[2] === 'suspend' ? 'suspended' : 'session_expired';
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      // 题面说 account_status 事件是"可能（不保证）"推送的，所以做成开关
      const pushAccountStatus = body['pushAccountStatus'] !== false;
      markAccountTerminal(accountId, to, { pushAccountStatus });
      return { ok: true, accountId, status: to, pushedAccountStatus: pushAccountStatus };
    });
  }

  m = /^\/_mock\/accounts\/([^/]+)\/rate-limit$/.exec(path);
  if (m) {
    const accountId = decodeURIComponent(m[1]!);
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const retryAfterSeconds = (body['retryAfterSeconds'] as number) ?? 5;
      setRateLimit(accountId, retryAfterSeconds);
      return { ok: true, accountId, retryAfterSeconds };
    });
  }

  m = /^\/_mock\/accounts\/([^/]+)\/clear-rate-limit$/.exec(path);
  if (m) {
    const accountId = decodeURIComponent(m[1]!);
    return wrap(res, async () => {
      // 直接改回 online，便于测试"到期前人工干预"的分支
      const account = getAccount(accountId);
      if (account === undefined) return false;
      account.status = 'online';
      account.rateLimitedUntil = null;
      account.retryAfterSeconds = null;
      return { ok: true, accountId };
    });
  }

  // --- 群 ---
  m = /^\/_mock\/groups\/([^/]+)\/(external-join|external-leave)$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]!);
    const action = m[2];
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const platformUserId = (body['platformUserId'] as string) ?? 'pu_external_user';
      return action === 'external-join'
        ? externalJoin(groupId, platformUserId)
        : externalLeave(groupId, platformUserId);
    });
  }

  m = /^\/_mock\/groups\/([^/]+)\/write-forbidden$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]!);
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      return setWriteForbidden(groupId, (body['on'] as boolean) !== false);
    });
  }

  m = /^\/_mock\/groups\/([^/]+)\/dissolve$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]!);
    return wrap(res, async () => dissolveGroup(groupId));
  }

  m = /^\/_mock\/groups\/([^/]+)\/owner-leave$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]!);
    return wrap(res, async () => {
      return ownerLeave(groupId);
    });
  }

  m = /^\/_mock\/groups\/([^/]+)\/kick-timeout$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]!);
    return wrap(res, async () => {
      armKickTimeout(groupId);
      return { ok: true, message: '下一次该群的 kick 将返回 504 NETWORK_TIMEOUT' };
    });
  }

  // --- 消息注入 ---
  if (path === '/_mock/messages/inject') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const rawEntries = Array.isArray(body) ? body : (body['messages'] as unknown[]) ?? [body];
      const entries = rawEntries as ReinjectEntry[];
      reinjectMessages(entries);
      return { ok: true, injected: entries.length };
    });
  }

  // --- 事件流行为 ---
  if (path === '/_mock/events/replay') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const fromEventId = (body['fromEventId'] as number) ?? 1;
      const count = (body['count'] as number) ?? 100;
      const events = bus.eventsInRange(fromEventId, count);
      // 重新推送这些事件：eventId 保持不变（这就是"重复推送"的语义）
      for (const event of events) bus.rePublish(event);
      return { ok: true, replayed: events.length };
    });
  }

  if (path === '/_mock/events/duplicate-mode') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const on = bus.setDuplicateMode((body['on'] as boolean) !== false);
      return { ok: true, duplicateMode: on };
    });
  }

  if (path === '/_mock/events/shuffle-mode') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const on = bus.setShuffleMode((body['on'] as boolean) !== false);
      return { ok: true, shuffleMode: on };
    });
  }

  if (path === '/_mock/events/break-connection') {
    return wrap(res, async () => {
      const before = activeConnectionCount();
      bus.breakAllConnections();
      return { ok: true, closedConnections: before };
    });
  }

  // --- 通用故障注入 ---
  // 支持三种写法：
  //   { endpoint, mode, ... }              安装/更新一条规则（mode='off' 等同清除）
  //   { clear: '<endpoint>' }              清除单条
  //   { clearAll: true }                   清空全部
  if (path === '/_mock/faults') {
    try {
      const body = await readJsonBody(req);
      if (body['clearAll'] === true) {
        resetFaults();
        sendJson(res, 200, { ok: true, faults: listFaults() });
        return true;
      }
      if (typeof body['clear'] === 'string') {
        clearFault(body['clear']);
        sendJson(res, 200, { ok: true, faults: listFaults() });
        return true;
      }
      const rule = setFault({
        endpoint: body['endpoint'] as string,
        mode: body['mode'] as string,
        persist: body['persist'] as boolean | undefined,
        count: body['count'] as number | undefined,
        probability: body['probability'] as number | undefined,
        delayMs: body['delayMs'] as number | undefined,
        landAfterMs: body['landAfterMs'] as number | undefined,
      });
      sendJson(res, 200, { ok: true, rule, faults: listFaults() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, 'BAD_REQUEST', { message });
    }
    return true;
  }

  // --- 行为开关 ---
  if (path === '/_mock/behavior') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      if (body['joinNeverArrives'] !== undefined) {
        behavior.joinNeverArrives = Number(body['joinNeverArrives']);
      }
      if (body['failJoinOnce'] !== undefined) {
        behavior.failJoinOnce = body['failJoinOnce'] === true;
      }
      return { ok: true, behavior: { ...behavior } };
    });
  }

  // --- 时序档案 ---
  if (path === '/_mock/timing') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const profile = body['profile'] as string;
      const ok = setTimingProfile(profile as 'real' | 'fast');
      if (!ok) {
        sendError(res, 400, 'UNKNOWN_PROFILE', {
          available: Object.keys(TIMING_PROFILES),
        });
        return { __handled: true };
      }
      return { ok: true, profile };
    });
  }

  // --- 重置 ---
  if (path === '/_mock/reset') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      resetState();
      resetFaults(); // 故障规则与业务状态一起回到"全部默认关闭"
      // 默认不清零 eventId 计数器（与使用方确认过的决定）：
      // eventId 的全局单调性是网关对外契约，清零会让 since 补拉语义难以验证。
      bus.resetEventBus({ resetCounter: body['resetEventCounter'] === true });
      if (Array.isArray(body['seedAccounts'])) seedAccounts(body['seedAccounts'] as string[]);
      return {
        ok: true,
        reseededAccounts: config.seedAccounts,
        eventCounterReset: body['resetEventCounter'] === true,
      };
    });
  }

  return false;
}

async function wrap(res: ServerResponse, fn: () => Promise<unknown>): Promise<true> {
  try {
    const result = await fn();
    if (result !== undefined && result !== false) sendJson(res, 200, result);
  } catch (err) {
    console.error('[gateway/_mock] 异常:', err);
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'MOCK_ERROR', { message });
  }
  return true;
}
