/** 后端 API 的 DTO 类型（与 docs/examination_project.md §2.3 对齐）。 */

// ---- 账号 ----
export type AccountStatus =
  | 'idle'
  | 'online'
  | 'disconnected'
  | 'rate_limited'
  | 'suspended'
  | 'session_expired';

export interface AccountDto {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
}

// ---- 群 ----
export type GroupStatus = 'active' | 'unreachable' | 'left';
export type MemberRole = 'creator' | 'admin' | 'member';

export interface GroupSummaryDto {
  id: string;
  gatewayGroupId: string;
  status: GroupStatus;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberDto {
  accountId: string | null;
  platformUserId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface GroupDetailDto extends GroupSummaryDto {
  members: GroupMemberDto[];
  activeRunId: string | null;
}

// ---- 消息时间线 ----
export type DeliveryStatus =
  | 'queued'
  | 'accepted'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export interface TimelineItemDto {
  msgId: string | null;
  clientMsgId: string | null;
  senderPlatformUserId: string;
  isOwn: boolean;
  text: string;
  sentAt: string;
  deliveryStatus: DeliveryStatus | null;
  failCode: string | null;
}

export interface TimelinePageDto {
  items: TimelineItemDto[];
  nextCursor: string | null;
}

// ---- Agent Run ----
export type AgentRunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';

export interface AgentRunListItemDto {
  id: string;
  status: AgentRunStatus;
  endReason: string | null;
  summary: string | null;
  accumulatedMs: number;
  createdAt: string;
}

// ---- WebSocket 事件帧 ----
export interface WsEventFrame {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}
