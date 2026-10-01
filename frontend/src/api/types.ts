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
export type AgentStepKind = 'tool_use' | 'final' | 'protocol_error';

export interface AgentRunListItemDto {
  id: string;
  status: AgentRunStatus;
  endReason: string | null;
  summary: string | null;
  accumulatedMs: number;
  createdAt: string;
}

/** GET /api/agent-runs/:id 的单步（页面 4，§2.3）。 */
export interface AgentStepDto {
  stepNo: number;
  kind: AgentStepKind;
  /** 工具名（finish 也是工具名）；protocol_error 步为 null。 */
  name: string | null;
  toolUseId: string | null;
  /** 工具入参（原样 JSON）；协议错误步为 null。 */
  input: unknown;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  /** Agent 服务原始响应体（截断 2KB）；仅协议错误等场景非 null。 */
  rawResponse: string | null;
  createdAt: string;
}

export interface AgentRunDetailDto extends AgentRunListItemDto {
  groupId: string;
  steps: AgentStepDto[];
}

// ---- 定时序列 ----
export type SequenceRunStatus = 'running' | 'finished' | 'failed' | 'stopped';
export type SequenceStepStatus = 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';
export type SequenceAccountRole = 'admin' | 'member';

export interface SequenceStepDefDto {
  /** 后端模板不存 index，由数组下标决定（0 基）；预检/详情里显式返回 stepIndex。 */
  text: string;
  delaySeconds: number;
  accountRole: SequenceAccountRole;
}

export interface SequenceDto {
  id: string;
  name: string;
  steps: SequenceStepDefDto[];
  createdAt: string;
}

/** POST /api/sequences/precheck 200 响应。 */
export interface PrecheckStepDto {
  stepIndex: number;
  accountRole: SequenceAccountRole;
  delaySeconds: number;
  text: string;
  resolvedText: string;
  resolvedVars: Record<string, string>;
  varSources: Record<string, string>;
}

export interface PrecheckResultDto {
  sequenceId: string;
  name: string;
  steps: PrecheckStepDto[];
}

export interface SequenceRunListItemDto {
  id: string;
  sequenceId: string;
  status: SequenceRunStatus;
  currentStepIndex: number;
  createdAt: string;
}

export interface SequenceRunStepDto {
  stepIndex: number;
  status: SequenceStepStatus;
  outboxId: string | null;
  clientMsgId: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  resolvedVars: Record<string, string> | null;
  varSources: Record<string, string> | null;
}

export interface SequenceRunDetailDto {
  id: string;
  groupId: string;
  sequenceId: string;
  status: SequenceRunStatus;
  currentStepIndex: number;
  vars: Record<string, string>;
  stepVars: Record<string, Record<string, string>>;
  createdAt: string;
  steps: SequenceRunStepDto[];
}

// ---- WebSocket 事件帧 ----
export interface WsEventFrame {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}
