/**
 * 控制端点（模拟器私有，前缀 /_mock/）。
 *
 * 这些端点**不属于题面定义的网关契约**，仅供测试驱动程序复现故障场景
 * （S1-S8 及后端自测）。后端代码不应依赖它们——code review 时需检查。
 *
 * 全部 POST 端点返回 { ok: true, ... }。
 */
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
  armKickTimeout,
  reinjectMessages,
  seedAccounts,
} from './store.js';
import { sendError, sendJson, readJsonBody, activeConnectionCount } from './lib/http.js';
import * as bus from './lib/event-bus.js';
import { setTimingProfile, TIMING_PROFILES, currentTimingProfile } from './lib/timing.js';
import { config } from './config.js';

/**
 * 处理一个控制请求。
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handle(req, res, url) {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // --- 只读查询 ---
  if (method === 'GET' && path === '/_mock/state') {
    sendJson(res, 200, {
      ...dumpState(),
      lastEventId: bus.lastEventId(),
      delivery: bus.deliveryFlags(),
      behavior: { ...behavior },
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
    const accountId = decodeURIComponent(m[1]);
    const to = m[2] === 'suspend' ? 'suspended' : 'session_expired';
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      // 题面说 account_status 事件是"可能（不保证）"推送的，所以做成开关
      const pushAccountStatus = body.pushAccountStatus !== false;
      markAccountTerminal(accountId, to, { pushAccountStatus });
      return { ok: true, accountId, status: to, pushedAccountStatus: pushAccountStatus };
    });
  }

  m = /^\/_mock\/accounts\/([^/]+)\/rate-limit$/.exec(path);
  if (m) {
    const accountId = decodeURIComponent(m[1]);
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const retryAfterSeconds = body.retryAfterSeconds ?? 5;
      setRateLimit(accountId, retryAfterSeconds);
      return { ok: true, accountId, retryAfterSeconds };
    });
  }

  m = /^\/_mock\/accounts\/([^/]+)\/clear-rate-limit$/.exec(path);
  if (m) {
    const accountId = decodeURIComponent(m[1]);
    return wrap(res, async () => {
      // 直接改回 online，便于测试"到期前人工干预"的分支
      const { getAccount } = await import('../store.js');
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
    const groupId = decodeURIComponent(m[1]);
    const action = m[2];
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const platformUserId = body.platformUserId ?? 'pu_external_user';
      return action === 'external-join'
        ? externalJoin(groupId, platformUserId)
        : externalLeave(groupId, platformUserId);
    });
  }

  m = /^\/_mock\/groups\/([^/]+)\/write-forbidden$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]);
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      return setWriteForbidden(groupId, body.on !== false);
    });
  }

  m = /^\/_mock\/groups\/([^/]+)\/owner-leave$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]);
    return wrap(res, async () => {
      return ownerLeave(groupId);
    });
  }

  m = /^\/_mock\/groups\/([^/]+)\/kick-timeout$/.exec(path);
  if (m) {
    const groupId = decodeURIComponent(m[1]);
    return wrap(res, async () => {
      armKickTimeout(groupId);
      return { ok: true, message: '下一次该群的 kick 将返回 504 NETWORK_TIMEOUT' };
    });
  }

  // --- 消息注入 ---
  if (path === '/_mock/messages/inject') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const entries = Array.isArray(body) ? body : body.messages ?? [body];
      reinjectMessages(entries);
      return { ok: true, injected: entries.length };
    });
  }

  // --- 事件流行为 ---
  if (path === '/_mock/events/replay') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const events = bus.eventsInRange(body.fromEventId ?? 1, body.count ?? 100);
      // 重新推送这些事件：eventId 保持不变（这就是"重复推送"的语义）
      for (const event of events) bus.rePublish(event);
      return { ok: true, replayed: events.length };
    });
  }

  if (path === '/_mock/events/duplicate-mode') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const on = bus.setDuplicateMode(body.on !== false);
      return { ok: true, duplicateMode: on };
    });
  }

  if (path === '/_mock/events/shuffle-mode') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const on = bus.setShuffleMode(body.on !== false);
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

  // --- 行为开关 ---
  if (path === '/_mock/behavior') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      if (body.joinNeverArrives !== undefined) {
        behavior.joinNeverArrives = Number(body.joinNeverArrives);
      }
      if (body.failJoinOnce !== undefined) {
        behavior.failJoinOnce = body.failJoinOnce === true;
      }
      return { ok: true, behavior: { ...behavior } };
    });
  }

  // --- 时序档案 ---
  if (path === '/_mock/timing') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      const ok = setTimingProfile(body.profile);
      if (!ok) {
        sendError(res, 400, 'UNKNOWN_PROFILE', {
          available: Object.keys(TIMING_PROFILES),
        });
        return { __handled: true };
      }
      return { ok: true, profile: body.profile };
    });
  }

  // --- 重置 ---
  if (path === '/_mock/reset') {
    return wrap(res, async () => {
      const body = await readJsonBody(req);
      resetState();
      // 默认不清零 eventId 计数器（与使用方确认过的决定）：
      // eventId 的全局单调性是网关对外契约，清零会让 since 补拉语义难以验证。
      bus.resetEventBus({ resetCounter: body.resetEventCounter === true });
      if (Array.isArray(body.seedAccounts)) seedAccounts(body.seedAccounts);
      return {
        ok: true,
        reseededAccounts: config.seedAccounts,
        eventCounterReset: body.resetEventCounter === true,
      };
    });
  }

  return false;
}

async function wrap(res, fn) {
  try {
    const result = await fn();
    if (result !== undefined && result !== false) sendJson(res, 200, result);
  } catch (err) {
    console.error('[gateway/_mock] 异常:', err);
    sendError(res, 500, 'MOCK_ERROR', { message: String(err?.message ?? err) });
  }
  return true;
}
