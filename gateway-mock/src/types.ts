/**
 * 网关模拟器的**契约类型**——对外接口、内部状态、事件负载的唯一类型来源。
 *
 * 这些类型直接对应 `docs/examination_project.md` §2.1 与
 * `docs/plan/01-gateway-mock.md` §2 的状态模型。任何字段的增删都应先改这里，
 * 让编译期把所有受影响的调用点暴露出来。
 *
 * 约定：可空字段一律写成 `T | null`（而不是可选属性 `T?`），
 * 与 `exactOptionalPropertyTypes` 配合，强制调用方显式表达"没有值"。
 */

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

/**
 * 账号状态。
 *
 * idle → 从未 connect；online → 已 connect；disconnected → 主动 disconnect；
 * rate_limited → 被限流（等待期结束自动回 online）；
 * suspended / session_expired → 终态，之后该账号**所有请求**返回同码错误。
 */
export type AccountStatus =
  | 'idle'
  | 'online'
  | 'disconnected'
  | 'rate_limited'
  | 'suspended'
  | 'session_expired';

/** 处于终态的状态集合：进入后不可恢复，且会自动移出所有群。 */
export const TERMINAL_STATUSES = ['suspended', 'session_expired'] as const satisfies readonly AccountStatus[];

/** 账号（内部状态）。 */
export interface Account {
  readonly accountId: string;
  status: AccountStatus;
  /** connect 时按 accountId 确定性派生；未 connect 过为 null。 */
  platformUserId: string | null;
  /** 限流到期时间戳（ms）；仅 rate_limited 期间有值。 */
  rateLimitedUntil: number | null;
  /** 最近一次限流返回的 retryAfterSeconds。 */
  retryAfterSeconds: number | null;
  /** 当前所在的群（逻辑视图；成员变更时同步维护）。 */
  readonly joinedGroups: Set<string>;
}

// ---------------------------------------------------------------------------
// 群与成员
// ---------------------------------------------------------------------------

/** 成员角色。群主唯一；promote 后为 admin。 */
export type MemberRole = 'owner' | 'admin' | 'member';

/** 群成员。accountId 为 null 表示外部用户（非服务账号）。 */
export interface Member {
  readonly platformUserId: string;
  readonly accountId: string | null;
  role: MemberRole;
}

/** 邀请链接。readyAt 之前使用 → 409 INVITE_NOT_READY；过期 → 410 INVITE_EXPIRED。 */
export interface Invite {
  readonly readyAt: number;
  /** null 表示不过期。 */
  readonly expiresAt: number | null;
}

/** 群（内部状态）。解散后仍保留条目，便于返回确定性的错误码。 */
export interface Group {
  readonly groupId: string;
  readonly creatorAccountId: string;
  readonly ownerPlatformUserId: string;
  readonly members: Map<string, Member>;
  writeForbidden: boolean;
  readonly invites: Map<string, Invite>;
  /** 尚未触发的 member_joined 定时器，reset 时要清掉。 */
  readonly joinTimers: Set<NodeJS.Timeout>;
  /** 逻辑上是否存在（解散后为 false）。 */
  readonly joined: boolean;
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

/** 一条已落地的消息。 */
export interface MessageRecord {
  readonly msgId: string;
  readonly groupId: string;
  readonly senderPlatformUserId: string | null;
  readonly text: string;
  /** ISO 字符串，毫秒精度；同毫秒可以有多条。 */
  readonly sentAt: string;
  readonly clientMsgId: string | null;
  readonly mediaUrl: string | null;
}

/** by-client-id 索引里的条目。 */
export interface ClientMsgRef {
  readonly msgId: string;
  readonly sentAt: string;
}

/**
 * 补投消息的输入形状（`/_mock/messages/inject`）。
 * 与 MessageRecord 的区别：调用方不提供 msgId（由模拟器分配）。
 */
export interface ReinjectEntry {
  readonly groupId: string;
  readonly senderPlatformUserId: string | null;
  readonly text: string;
  readonly sentAt: string;
  readonly clientMsgId?: string | null;
  readonly mediaUrl?: string | null;
}

// ---------------------------------------------------------------------------
// 事件流
// ---------------------------------------------------------------------------

/** 事件类型。题面 §2.1 定义的全部事件。 */
export type GatewayEventType =
  | 'message'
  | 'message_sent'
  | 'message_failed'
  | 'member_joined'
  | 'member_left'
  | 'account_status';

/**
 * 所有事件共有的字段。
 *
 * eventId 在**入队时**分配，全局单调递增、append-only；
 * 重复推送（duplicate）与乱序（shuffle）只改变**发送时刻**，绝不改变 eventId。
 */
export interface GatewayEventBase {
  readonly eventId: number;
}

/** 群内新消息（含自己发出的消息被推回）。 */
export interface MessageEvent extends GatewayEventBase {
  readonly type: 'message';
  readonly groupId: string;
  readonly msgId: string;
  readonly senderPlatformUserId: string | null;
  readonly text: string;
  readonly sentAt: string;
  /** C1 选做的媒体地址；不带该字段时 JSON 里不出现此键。 */
  readonly mediaUrl?: string;
}

/** send 被网关受理并落地。 */
export interface MessageSentEvent extends GatewayEventBase {
  readonly type: 'message_sent';
  readonly clientMsgId: string;
  readonly msgId: string;
  readonly sentAt: string;
}

/** send 被网关受理但最终失败。 */
export interface MessageFailedEvent extends GatewayEventBase {
  readonly type: 'message_failed';
  readonly clientMsgId: string;
  readonly code: string;
}

export interface MemberJoinedEvent extends GatewayEventBase {
  readonly type: 'member_joined';
  readonly groupId: string;
  readonly platformUserId: string;
}

export interface MemberLeftEvent extends GatewayEventBase {
  readonly type: 'member_left';
  readonly groupId: string;
  readonly platformUserId: string;
}

/** 账号进入终态的通知。题面用词是"可能推送"，因此可开关。 */
export interface AccountStatusEvent extends GatewayEventBase {
  readonly type: 'account_status';
  readonly accountId: string;
  readonly status: AccountStatus;
}

/** 事件联合类型：按 type 判别，publish 的负载类型由它推导。 */
export type GatewayEvent =
  | MessageEvent
  | MessageSentEvent
  | MessageFailedEvent
  | MemberJoinedEvent
  | MemberLeftEvent
  | AccountStatusEvent;

/** 取出某个类型的事件。 */
export type EventOf<K extends GatewayEventType> = Extract<GatewayEvent, { type: K }>;

/** 事件的负载部分（去掉由 event-bus 负责分配的 eventId 与 type）。 */
export type EventBody<K extends GatewayEventType> = Omit<EventOf<K>, 'eventId' | 'type'>;

// ---------------------------------------------------------------------------
// 时序档案
// ---------------------------------------------------------------------------

/**
 * 时序档案。题面给出的所有延迟数字集中在这里定义，是"时序"的唯一来源。
 * 压缩只影响等待时长，不影响任何业务语义（谁先谁后、谁成功谁失败）。
 */
export interface TimingProfile {
  /** POST /groups/:id/send 返回 202 之前的延迟 */
  readonly sendAcceptedDelayMin: number;
  readonly sendAcceptedDelayMax: number;
  /** 从受理到推 message_sent / message_failed 的延迟 */
  readonly messageSentDelayMin: number;
  readonly messageSentDelayMax: number;
  /** join 被受理到推 member_joined 的延迟 */
  readonly joinDelayMin: number;
  readonly joinDelayMax: number;
  /** kick 返回前的处理耗时 */
  readonly kickDelayMin: number;
  readonly kickDelayMax: number;
  /** 504 之后消息"收敛"（落地或确认没落地）的时间 */
  readonly networkTimeoutConvergence: number;
  /** 事件乱序窗口上限（题面：≤ 1 秒） */
  readonly shuffleWindowMax: number;
}

/** 档案名。real = 题面时序；fast = 压缩到毫秒级，供 e2e 测试。 */
export type TimingProfileName = 'real' | 'fast';
