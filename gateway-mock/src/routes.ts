/**
 * 网关对外路由（题面 §2.1 定义的接口）。
 *
 * 这里只做三件事：解析路径与请求体 → 调 store → 写响应。
 * 业务规则一律在 store 里，便于被测试直接调用而不经过 HTTP。
 *
 * 路径约定：
 *   账号  POST /accounts/:accountId/connect | /disconnect
 *   群    POST /groups
 *         POST /groups/:groupId/invite | /join | /promote | /kick | /leave
 *         GET  /groups/:groupId/members
 *   消息  POST /groups/:groupId/send
 *         GET  /groups/:groupId/messages/by-client-id/:clientMsgId
 *   事件  GET  /events?since=<eventId>
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GatewayError,
  connectAccount,
  disconnectAccount,
  createGroup,
  createInvite,
  joinGroup,
  promoteMember,
  kickMember,
  leaveGroup,
  listMembers,
  assertCanSend,
  acceptSend,
  findByClientMsgId,
  consumeKickTimeout,
  sleep,
} from './store.js';
import { randBetween, timing } from './lib/timing.js';
import { sendError, sendJson, readJsonBody, openEventStream } from './lib/http.js';
import * as bus from './lib/event-bus.js';

/**
 * 处理一个网关请求。
 * @returns 是否已处理（false 表示不属于本模块的路径）
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // --- SSE 事件流 ---
  if (method === 'GET' && path === '/events') {
    const sinceRaw = url.searchParams.get('since');
    // 不带 since（或非法值）→ 从当前时刻开始，即 since = 当前最大 eventId
    const since = sinceRaw === null ? bus.lastEventId() : Number(sinceRaw);
    openEventStream(res, bus, Number.isFinite(since) ? since : bus.lastEventId());
    return true;
  }

  // --- 账号 ---
  // 路径参数必须在闭包外提取：TS 不会在异步闭包内保留对正则匹配结果 m 的非空收窄。
  let m = /^\/accounts\/([^/]+)\/connect$/.exec(path);
  if (m && method === 'POST') {
    const accountId = decodeURIComponent(m[1]!);
    return handled(res, () => connectAccount(accountId));
  }

  m = /^\/accounts\/([^/]+)\/disconnect$/.exec(path);
  if (m && method === 'POST') {
    const accountId = decodeURIComponent(m[1]!);
    return handled(res, () => disconnectAccount(accountId));
  }

  // --- 建群 ---
  if (path === '/groups' && method === 'POST') {
    return handled(res, async () => {
      const body = await readJsonBody(req);
      return createGroup(body['creatorAccountId'] as string);
    });
  }

  m = /^\/groups\/([^/]+)\/invite$/.exec(path);
  if (m && method === 'POST') {
    const groupId = decodeURIComponent(m[1]!);
    return handled(res, async () => {
      const body = await readJsonBody(req);
      // 允许调用方指定 readyAfterMs / 链接 TTL（测试用）；不传则由模拟器随机决定。
      // exactOptionalPropertyTypes 下不能显式传 undefined，按字段是否存在逐个挂入。
      const options: { readyAfterMs?: number; ttlMs?: number } = {};
      if (typeof body['readyAfterMs'] === 'number') {
        options.readyAfterMs = body['readyAfterMs'];
      }
      if (typeof body['ttlMs'] === 'number') {
        options.ttlMs = body['ttlMs'];
      }
      return createInvite(groupId, options);
    });
  }

  m = /^\/groups\/([^/]+)\/join$/.exec(path);
  if (m && method === 'POST') {
    const groupId = decodeURIComponent(m[1]!);
    return handled(res, async () => {
      const body = await readJsonBody(req);
      joinGroup(groupId, body['accountId'] as string, body['inviteLink'] as string);
      return { accepted: true as const };
    }, 202);
  }

  m = /^\/groups\/([^/]+)\/promote$/.exec(path);
  if (m && method === 'POST') {
    const groupId = decodeURIComponent(m[1]!);
    return handled(res, async () => {
      const body = await readJsonBody(req);
      return promoteMember(groupId, body['byAccountId'] as string, body['accountId'] as string);
    });
  }

  m = /^\/groups\/([^/]+)\/kick$/.exec(path);
  if (m && method === 'POST') {
    const groupId = decodeURIComponent(m[1]!);
    return handled(res, async () => {
      const body = await readJsonBody(req);
      // 一次性故障：下一次 kick 返回 504 NETWORK_TIMEOUT（结果未知）
      if (consumeKickTimeout(groupId)) {
        // 模拟真实网关：耗时一会儿才失败
        await sleep(randBetween(timing().kickDelayMin, timing().kickDelayMax));
        throw new GatewayError(504, 'NETWORK_TIMEOUT');
      }
      // 正常路径：响应需要 1-5 秒
      await sleep(randBetween(timing().kickDelayMin, timing().kickDelayMax));
      return kickMember(groupId, body['byAccountId'] as string, body['targetPlatformUserId'] as string);
    });
  }

  m = /^\/groups\/([^/]+)\/leave$/.exec(path);
  if (m && method === 'POST') {
    const groupId = decodeURIComponent(m[1]!);
    return handled(res, async () => {
      const body = await readJsonBody(req);
      return leaveGroup(groupId, body['accountId'] as string);
    });
  }

  m = /^\/groups\/([^/]+)\/members$/.exec(path);
  if (m && method === 'GET') {
    const groupId = decodeURIComponent(m[1]!);
    return handled(res, () => listMembers(groupId));
  }

  // --- 发消息 ---
  m = /^\/groups\/([^/]+)\/send$/.exec(path);
  if (m && method === 'POST') {
    const groupId = decodeURIComponent(m[1]!);
    return handled(res, async () => {
      const body = await readJsonBody(req);
      // 前置校验（离线/限流/不在群/群不可写）都在这里抛出同步错误
      assertCanSend(groupId, body['accountId'] as string);
      // 校验通过后仍要延迟才返回 202，并异步推 message_sent / message_failed
      await acceptSend(groupId, body['accountId'] as string, body['clientMsgId'] as string, body['text'] as string);
      return { accepted: true as const };
    }, 202);
  }

  m = /^\/groups\/([^/]+)\/messages\/by-client-id\/([^/]+)$/.exec(path);
  if (m && method === 'GET') {
    const groupId = decodeURIComponent(m[1]!);
    const clientMsgId = decodeURIComponent(m[2]!);
    return handled(res, () => {
      const found = findByClientMsgId(groupId, clientMsgId);
      if (found === null) {
        throw new GatewayError(404, 'NOT_FOUND');
      }
      return { msgId: found.msgId, sentAt: found.sentAt };
    });
  }

  return false;
}

/**
 * 统一的处理包装：把 store 的返回值写成 JSON，把 GatewayError 转成网关错误响应。
 * @param status 成功时的状态码，默认 200
 */
async function handled(res: ServerResponse, fn: () => Promise<unknown> | unknown, status = 200): Promise<true> {
  try {
    const result = await fn();
    sendJson(res, status, result);
  } catch (err) {
    if (err instanceof GatewayError) {
      sendError(res, err.status, err.code, err.extra);
      return true;
    }
    // 非预期异常：打印堆栈便于排障，对外只给错误码
    console.error('[gateway] 未预期异常:', err);
    sendError(res, 500, 'INTERNAL_ERROR');
  }
  return true;
}
