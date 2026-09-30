/**
 * 网关模拟器的内部状态与业务逻辑。
 *
 * 状态全部保存在内存中：进程重启即清空（题面未要求网关持久化，README 已声明）。
 *
 * 设计要点：
 *  - 所有"成员变更"与"事件推送"是**两步**：成员列表在该变的时刻立即变，
 *    对应事件在其后（可配置延迟）才推出。这与题面一致
 *    （"账号实际进出群的那一刻成员列表就已变化，事件在其后推出"）。
 *  - 所有延迟都走 timing 档案，关掉压缩时就是题面给出的真实时序。
 */
import { publish } from './lib/event-bus.js';
import { derivePlatformUserId, newGroupId, newMsgId, newInviteLink } from './lib/ids.js';
import { timing, randBetween } from './lib/timing.js';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * accountId -> {
 *   accountId, status, platformUserId,
 *   rateLimitedUntil: number|null,   // 限流到期时间戳(ms)
 *   retryAfterSeconds: number|null,  // 最近一次限流返回的 retryAfterSeconds
 *   joinedGroups: Set<groupId>,
 * }
 *
 * status: idle | online | disconnected | suspended | session_expired
 */
const accounts = new Map();

/**
 * groupId -> {
 *   groupId, creatorAccountId, ownerPlatformUserId,
 *   members: Map<platformUserId, { platformUserId, accountId|null, role }>,
 *   writeForbidden: boolean,
 *   invites: Map<inviteLink, { readyAt: number, expiresAt: number|null }>,
 *   joinTimers: Set<Timeout>,
 *   joined: boolean,      // 逻辑上是否存在（解散后仍保留，便于返回确定性错误）
 * }
 */
const groups = new Map();

/** msgId -> { msgId, groupId, senderPlatformUserId, text, sentAt, clientMsgId|null, mediaUrl|null } */
const messages = new Map();

/** `${groupId}::${clientMsgId}` -> [{ msgId, sentAt }]，保留全部，查询时返回最早一条 */
const clientMsgIndex = new Map();

/** 行为开关（由 /_mock/behavior 控制）。 */
export const behavior = {
  /** >0 时 join 授权后按该概率"永远不推 member_joined" */
  joinNeverArrives: config.joinNeverArrivesProbability,
  /** 发起 join 时是否强制失败一次（模拟 join 报错后重试成功） */
  failJoinOnce: false,
};

/** group / account 级的一次性故障（由 /_mock/groups、/_mock/accounts 控制）。 */
const oneShotFaults = {
  kickTimeoutGroups: new Set(), // 下一次 kick 返回 504 的群
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 网关业务错误。携带 HTTP 状态码与网关错误码。
 * message 与题面错误码保持一致（如 RATE_LIMITED、ACCOUNT_OFFLINE）。
 */
export class GatewayError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

/** 初始化预置账号。 */
export function seedAccounts(accountIds) {
  for (const accountId of accountIds) {
    if (accounts.has(accountId)) continue;
    accounts.set(accountId, {
      accountId,
      status: 'idle',
      platformUserId: null,
      rateLimitedUntil: null,
      retryAfterSeconds: null,
      joinedGroups: new Set(),
    });
  }
}

export function getAccount(accountId) {
  return accounts.get(accountId);
}

export function listAccounts() {
  return [...accounts.values()].map((a) => ({
    accountId: a.accountId,
    status: a.status,
    platformUserId: a.platformUserId,
    rateLimitedUntil: a.rateLimitedUntil,
  }));
}

/**
 * 账号终态检查：suspended / session_expired 之后，该账号**所有请求**都返回同样错误。
 * 返回 null 表示没有问题。
 */
function terminalError(account) {
  if (account.status === 'suspended') {
    return new GatewayError(403, 'ACCOUNT_SUSPENDED');
  }
  if (account.status === 'session_expired') {
    return new GatewayError(401, 'SESSION_EXPIRED');
  }
  return null;
}

/**
 * 把账号推入终态（suspended / session_expired），并执行题面要求的连带后果：
 * 移出所有群 + 推 member_left。
 *
 * @param {boolean} pushAccountStatus 是否同时推一条 account_status 事件。
 *        题面对该事件用词是"可能（不保证）"，因此这里做成可开关，方便后端两边都测。
 */
export function markAccountTerminal(accountId, status, { pushAccountStatus = true } = {}) {
  const account = accounts.get(accountId);
  if (account === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');
  if (account.status === 'suspended' || account.status === 'session_expired') {
    return account; // 已是终态，幂等
  }

  account.status = status;
  account.rateLimitedUntil = null;
  account.retryAfterSeconds = null;

  // 移出所有群 + 推 member_left（题面：进入终态后网关会自动把账号移出所有群并推 member_left）
  if (account.platformUserId !== null) {
    for (const groupId of [...account.joinedGroups]) {
      removeMember(groupId, account.platformUserId, { scheduleEvent: true });
    }
  }

  if (pushAccountStatus) {
    publish('account_status', { accountId, status });
  }
  return account;
}

/** 给账号设置限流。 */
export function setRateLimit(accountId, retryAfterSeconds) {
  const account = accounts.get(accountId);
  if (account === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');
  account.status = 'rate_limited';
  account.retryAfterSeconds = retryAfterSeconds;
  account.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
  return account;
}

/** 限流是否仍然生效；过期则自动回 online（网关侧的到期恢复）。 */
function activeRateLimit(account) {
  if (account.status !== 'rate_limited') return null;
  if (account.rateLimitedUntil !== null && Date.now() >= account.rateLimitedUntil) {
    // 网关侧自动恢复；注意后端也有自己的 sweep，两边都应能独立正确
    account.status = 'online';
    account.rateLimitedUntil = null;
    account.retryAfterSeconds = null;
    return null;
  }
  return account.retryAfterSeconds ?? 1;
}

/**
 * connect：返回（必要时创建）platformUserId。
 * 同一 accountId 每次 connect 返回同一个 platformUserId。
 */
export function connectAccount(accountId) {
  const account = accounts.get(accountId);
  if (account === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');

  const terminal = terminalError(account);
  if (terminal !== null) throw terminal;

  // 确定性派生：即使进程重启后又 connect，也拿到同一个 platformUserId
  if (account.platformUserId === null) {
    account.platformUserId = derivePlatformUserId(accountId);
  }
  account.status = 'online';
  return { platformUserId: account.platformUserId };
}

/** disconnect：账号离线。 */
export function disconnectAccount(accountId) {
  const account = accounts.get(accountId);
  if (account === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');

  const terminal = terminalError(account);
  if (terminal !== null) throw terminal;

  account.status = 'disconnected';
  account.rateLimitedUntil = null;
  account.retryAfterSeconds = null;
  return {};
}

/**
 * 出站动作的通用前置检查（send / join / promote / kick / leave 共用）。
 * 返回 { account, group } 或抛出对应的网关错误。
 */
function assertCanAct(accountId, groupId) {
  const account = accounts.get(accountId);
  if (account === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');

  const terminal = terminalError(account);
  if (terminal !== null) throw terminal;

  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');

  // 离线账号：send/join/promote/kick/leave 一律 409 ACCOUNT_OFFLINE
  if (account.status !== 'online' && account.status !== 'rate_limited') {
    throw new GatewayError(409, 'ACCOUNT_OFFLINE');
  }
  return { account, group };
}

// ---------------------------------------------------------------------------
// 群与成员
// ---------------------------------------------------------------------------

/** 建群：创建者即群主，响应返回时已是成员；**不**推 member_joined。 */
export function createGroup(creatorAccountId) {
  const account = accounts.get(creatorAccountId);
  if (account === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');

  const terminal = terminalError(account);
  if (terminal !== null) throw terminal;

  if (account.platformUserId === null) {
    throw new GatewayError(409, 'ACCOUNT_OFFLINE'); // 未 connect 过，没有 platformUserId
  }

  const groupId = newGroupId();
  const ownerPlatformUserId = account.platformUserId;
  const group = {
    groupId,
    creatorAccountId,
    ownerPlatformUserId,
    members: new Map([[ownerPlatformUserId, { platformUserId: ownerPlatformUserId, accountId: creatorAccountId, role: 'owner' }]]),
    writeForbidden: false,
    invites: new Map(),
    joinTimers: new Set(),
    joined: true,
  };
  groups.set(groupId, group);
  account.joinedGroups.add(groupId);
  return { groupId };
}

export function getGroup(groupId) {
  return groups.get(groupId);
}

/** 群成员列表（平台视角）。 */
export function listMembers(groupId) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');
  return [...group.members.keys()].map((platformUserId) => ({ platformUserId }));
}

/**
 * 从群成员表移除，并按需在其后推 member_left 事件。
 *
 * 注意顺序：**先改成员列表，再（延迟）推事件**。这样调用方在收到
 * 200 响应后的任意时刻查成员列表，看到的都已经是"移除后"的状态。
 */
function removeMember(groupId, platformUserId, { scheduleEvent = true } = {}) {
  const group = groups.get(groupId);
  if (group === undefined) return false;

  const member = group.members.get(platformUserId);
  if (member === undefined) return false;

  group.members.delete(platformUserId);
  if (member.accountId !== null) {
    const account = accounts.get(member.accountId);
    account?.joinedGroups.delete(groupId);
  }

  if (scheduleEvent) {
    // 题面：kick 场景下"目标在 200 返回前已从成员列表移除，随后推 member_left"
    const delay = randBetween(timing().kickDelayMin, timing().kickDelayMax);
    setTimeout(() => {
      publish('member_left', { groupId, platformUserId });
    }, Math.min(delay, timing().kickDelayMax));
  }
  return true;
}

/** 申请邀请链接。readyAfterMs 可能为 0，也可能几秒；链接可能任意时刻过期。 */
export function createInvite(groupId, { readyAfterMs, ttlMs } = {}) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');

  const inviteLink = newInviteLink();
  const readyDelay = readyAfterMs ?? (Math.random() < 0.5 ? 0 : randBetween(1000, 3000));
  group.invites.set(inviteLink, {
    readyAt: Date.now() + readyDelay,
    // 默认不过期；测试可用 /_mock 强制设置过期
    expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs,
  });
  return { inviteLink, readyAfterMs: readyDelay };
}

/**
 * join：仅表示"受理"，真正入群以随后的 member_joined 为准。
 * 可能永远不推 member_joined（此时账号并未入群）。
 */
export function joinGroup(groupId, accountId, inviteLink) {
  const { account, group } = assertCanAct(accountId, groupId);

  if (group.writeForbidden) {
    // 群已解散/禁言时也不再允许加入
    throw new GatewayError(403, 'GROUP_WRITE_FORBIDDEN');
  }

  const invite = group.invites.get(inviteLink);
  if (invite === undefined) {
    throw new GatewayError(410, 'INVITE_EXPIRED');
  }
  if (Date.now() < invite.readyAt) {
    throw new GatewayError(409, 'INVITE_NOT_READY');
  }
  if (invite.expiresAt !== null && Date.now() >= invite.expiresAt) {
    group.invites.delete(inviteLink);
    throw new GatewayError(410, 'INVITE_EXPIRED');
  }

  if (account.platformUserId === null) {
    throw new GatewayError(409, 'ACCOUNT_OFFLINE');
  }
  // 已在群内：409 ALREADY_MEMBER，且不再推 member_joined
  if (group.members.has(account.platformUserId)) {
    throw new GatewayError(409, 'ALREADY_MEMBER');
  }

  if (behavior.failJoinOnce) {
    behavior.failJoinOnce = false;
    throw new GatewayError(500, 'INTERNAL_ERROR');
  }

  const platformUserId = account.platformUserId;
  const delay = randBetween(timing().joinDelayMin, timing().joinDelayMax);
  const neverArrives = Math.random() < behavior.joinNeverArrives;

  const timer = setTimeout(() => {
    group.joinTimers.delete(timer);
    if (neverArrives) return; // 账号并未入群
    if (group.members.has(platformUserId)) return;

    // 成员列表先变，事件随后推出
    group.members.set(platformUserId, { platformUserId, accountId, role: 'member' });
    account.joinedGroups.add(groupId);
    publish('member_joined', { groupId, platformUserId });
  }, delay);
  group.joinTimers.add(timer);

  return { accepted: true };
}

/**
 * promote：byAccountId 必须是群主；对方需已入群。
 * 题面：promote **不推事件**。
 */
export function promoteMember(groupId, byAccountId, accountId) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');

  const byAccount = accounts.get(byAccountId);
  if (byAccount === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');

  const terminal = terminalError(byAccount);
  if (terminal !== null) throw terminal;

  // byAccountId 必须是群主
  if (byAccount.platformUserId === null || byAccount.platformUserId !== group.ownerPlatformUserId) {
    throw new GatewayError(403, 'NO_PERMISSION');
  }

  const target = accounts.get(accountId);
  if (target === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');
  if (target.platformUserId === null || !group.members.has(target.platformUserId)) {
    throw new GatewayError(409, 'NOT_MEMBER_YET');
  }

  const member = group.members.get(target.platformUserId);
  member.role = 'admin';
  return {};
}

/**
 * kick：目标在 200 返回前已从成员列表移除，随后推 member_left。
 *
 * 校验顺序对齐题面：
 *  - 群主已退群 → 409 OWNER_LEFT（优先于权限检查）
 *  - 非群主且未被 promote → 403 NO_PERMISSION
 */
export function kickMember(groupId, byAccountId, targetPlatformUserId) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');

  const byAccount = accounts.get(byAccountId);
  if (byAccount === undefined) throw new GatewayError(404, 'ACCOUNT_NOT_FOUND');

  const terminal = terminalError(byAccount);
  if (terminal !== null) throw terminal;

  // 群主是否还在群里
  if (!group.members.has(group.ownerPlatformUserId)) {
    throw new GatewayError(409, 'OWNER_LEFT');
  }

  const actor = byAccount.platformUserId === null ? null : group.members.get(byAccount.platformUserId);
  if (actor === undefined || actor === null || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new GatewayError(403, 'NO_PERMISSION');
  }

  // 成员列表立即变化，事件随后推出
  removeMember(groupId, targetPlatformUserId, { scheduleEvent: true });
  return { kicked: true };
}

/** leave：200 + 随后 member_left；也可能返回 500（没退成）。 */
export function leaveGroup(groupId, accountId) {
  const { account, group } = assertCanAct(accountId, groupId);

  if (account.platformUserId === null || !group.members.has(account.platformUserId)) {
    throw new GatewayError(403, 'SENDER_NOT_IN_GROUP');
  }

  if (Math.random() < 0.05) {
    throw new GatewayError(500, 'INTERNAL_ERROR');
  }

  const isOwner = account.platformUserId === group.ownerPlatformUserId;
  removeMember(groupId, account.platformUserId, { scheduleEvent: true });

  // 群主退群后，成员列表里已无群主 —— 后续任何 kick 都会得到 409 OWNER_LEFT
  return { wasOwner: isOwner };
}

// ---------------------------------------------------------------------------
// 发消息
// ---------------------------------------------------------------------------

/**
 * 记录一条消息并分配 msgId / sentAt。返回 msgId。
 * 同时写入 clientMsgId 索引，供 by-client-id 查询使用。
 */
export function recordMessage({ groupId, senderPlatformUserId, text, sentAt, clientMsgId, mediaUrl = null }) {
  const msgId = newMsgId();
  const record = {
    msgId,
    groupId,
    senderPlatformUserId,
    text,
    sentAt,
    clientMsgId: clientMsgId ?? null,
    mediaUrl,
  };
  messages.set(msgId, record);

  if (clientMsgId !== undefined && clientMsgId !== null) {
    const key = `${groupId}::${clientMsgId}`;
    const list = clientMsgIndex.get(key) ?? [];
    list.push({ msgId, sentAt });
    clientMsgIndex.set(key, list);
  }
  return msgId;
}

/**
 * send 的前置校验（不含 202 延迟）。返回 { account, group }。
 * 网关**不按 clientMsgId 去重**，因此这里不做任何幂等处理。
 */
export function assertCanSend(groupId, accountId) {
  const { account, group } = assertCanAct(accountId, groupId);

  if (group.writeForbidden) {
    throw new GatewayError(403, 'GROUP_WRITE_FORBIDDEN');
  }
  if (account.platformUserId === null || !group.members.has(account.platformUserId)) {
    throw new GatewayError(403, 'SENDER_NOT_IN_GROUP');
  }
  // 限流：等待期内任何 send 都再得同样错误，并且计时重置
  const retryAfter = activeRateLimit(account);
  if (retryAfter !== null) {
    account.rateLimitedUntil = Date.now() + retryAfter * 1000;
    throw new GatewayError(429, 'RATE_LIMITED', { retryAfterSeconds: retryAfter });
  }
  return { account, group };
}

/**
 * 受理一条 send：延迟后推 message_sent 或 message_failed。
 * send 返回 202 本身也要延迟（题面：202 可能一两秒才返回）。
 */
export async function acceptSend(groupId, accountId, clientMsgId, text, { shouldFail = false, failCode = 'ACCOUNT_SUSPENDED' } = {}) {
  const acceptedDelay = randBetween(timing().sendAcceptedDelayMin, timing().sendAcceptedDelayMax);
  if (acceptedDelay > 0) await sleep(acceptedDelay);

  const deliveryDelay = randBetween(timing().messageSentDelayMin, timing().messageSentDelayMax);
  setTimeout(() => {
    if (shouldFail) {
      publish('message_failed', { clientMsgId, code: failCode });
      return;
    }
    const sentAt = new Date().toISOString(); // 毫秒精度
    const msgId = recordMessage({
      groupId,
      senderPlatformUserId: findPlatformUserId(accountId),
      text,
      sentAt,
      clientMsgId,
    });
    publish('message_sent', { clientMsgId, msgId, sentAt });

    // 网关把服务账号自己发出的消息也作为 message 事件推回（msgId 相同）
    setTimeout(() => {
      publish('message', {
        groupId,
        msgId,
        senderPlatformUserId: findPlatformUserId(accountId),
        text,
        sentAt,
      });
    }, 1);
  }, deliveryDelay);

  return { accepted: true };
}

function findPlatformUserId(accountId) {
  return accounts.get(accountId)?.platformUserId ?? null;
}

/**
 * by-client-id 查询。
 * 同一 clientMsgId 落地多条时返回**最早的一条**。
 */
export function findByClientMsgId(groupId, clientMsgId) {
  const list = clientMsgIndex.get(`${groupId}::${clientMsgId}`);
  if (list === undefined || list.length === 0) return null;
  // 最早的一条：按 sentAt 升序，sentAt 相同则按插入顺序
  return [...list].sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0))[0];
}

/**
 * 为一组消息补投事件：使用原始 msgId/sentAt，但分配**新的（更大的）eventId**。
 * 这正是题面描述的"离线账号之前发过的消息之后通过事件流补投"。
 */
export function reinjectMessages(entries) {
  for (const entry of entries) {
    const msgId = recordMessage({
      groupId: entry.groupId,
      senderPlatformUserId: entry.senderPlatformUserId,
      text: entry.text,
      sentAt: entry.sentAt,
      clientMsgId: entry.clientMsgId ?? null,
      mediaUrl: entry.mediaUrl ?? null,
    });
    publish('message', {
      groupId: entry.groupId,
      msgId,
      senderPlatformUserId: entry.senderPlatformUserId,
      text: entry.text,
      sentAt: entry.sentAt,
      ...(entry.mediaUrl != null ? { mediaUrl: entry.mediaUrl } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// 外部用户进出群
// ---------------------------------------------------------------------------

/**
 * 模拟外部用户（非服务账号）入群：直接改成员列表并推 member_joined。
 * 题面明确"外部用户进出群也会推"这两个事件。
 */
export function externalJoin(groupId, platformUserId) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');
  if (group.members.has(platformUserId)) return { joined: false };
  group.members.set(platformUserId, { platformUserId, accountId: null, role: 'member' });
  publish('member_joined', { groupId, platformUserId });
  return { joined: true };
}

export function externalLeave(groupId, platformUserId) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');
  if (!group.members.has(platformUserId)) return { left: false };
  removeMember(groupId, platformUserId, { scheduleEvent: true });
  return { left: true };
}

/** 把群标记为不可写（解散或禁言），与账号无关。 */
export function setWriteForbidden(groupId, on) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');
  group.writeForbidden = on === true;
  return { writeForbidden: group.writeForbidden };
}

/** 让群主退群（用于制造 409 OWNER_LEFT 场景）。 */
export function ownerLeave(groupId) {
  const group = groups.get(groupId);
  if (group === undefined) throw new GatewayError(404, 'GROUP_NOT_FOUND');
  removeMember(groupId, group.ownerPlatformUserId, { scheduleEvent: true });
  return { left: true };
}

// ---------------------------------------------------------------------------
// 状态导出与重置
// ---------------------------------------------------------------------------

/** 导出全量状态，供测试断言（例如"网关里恰好一条消息"）。 */
export function dumpState() {
  return {
    accounts: [...accounts.values()].map((a) => ({
      accountId: a.accountId,
      status: a.status,
      platformUserId: a.platformUserId,
      rateLimitedUntil: a.rateLimitedUntil,
      joinedGroups: [...a.joinedGroups],
    })),
    groups: [...groups.values()].map((g) => ({
      groupId: g.groupId,
      creatorAccountId: g.creatorAccountId,
      ownerPlatformUserId: g.ownerPlatformUserId,
      writeForbidden: g.writeForbidden,
      members: [...g.members.values()].map((m) => ({ platformUserId: m.platformUserId, accountId: m.accountId, role: m.role })),
    })),
    messages: [...messages.values()],
    // clientMsgId 落地计数：测试用它断言"恰好一条"
    clientMsgCounts: Object.fromEntries([...clientMsgIndex.entries()].map(([k, v]) => [k, v.length])),
  };
}

/**
 * 清空业务状态。
 *
 * 注意：**不重置 eventId 计数器**（与用户确认过的决定）。
 * 理由：eventId 全局单调递增是网关的对外契约，清零会让"事件流从服务启动即推送"
 * 与 since 补拉的语义变得难以验证；测试之间靠 eventId 的连续性区分新旧事件。
 */
export function resetState() {
  for (const group of groups.values()) {
    for (const timer of group.joinTimers) clearTimeout(timer);
  }
  accounts.clear();
  groups.clear();
  messages.clear();
  clientMsgIndex.clear();
  oneShotFaults.kickTimeoutGroups.clear();
  behavior.joinNeverArrives = config.joinNeverArrivesProbability;
  behavior.failJoinOnce = false;
  seedAccounts(config.seedAccounts);
}

// ---------------------------------------------------------------------------
// 一次性故障（供 kick 的 504 场景）
// ---------------------------------------------------------------------------

export function armKickTimeout(groupId) {
  oneShotFaults.kickTimeoutGroups.add(groupId);
}

export function consumeKickTimeout(groupId) {
  return oneShotFaults.kickTimeoutGroups.delete(groupId);
}

export { sleep, timing, randBetween };
