# 需求梳理：多账号群组消息平台

> 本文是对 `docs/examination_project.md`（笔试原始要求）的梳理与结构化拆解，用于指导实现、排期与自测。
> **权威来源仍是 `docs/examination_project.md`**；本文若与其冲突，以原文为准。

---

## 0. 一句话概括

做一个「多账号群组消息平台」的后端 + 操作控制台：代管若干服务账号，管理若干群，把群消息记成可靠时间线，按定时序列以指定角色账号发消息，并接入一个只能通过工具调用来行动的 Agent，让它读群消息、发消息、移除成员；操作员通过网页控制台管理并实时观察。

**技术栈**：后端 Node.js + TypeScript + PostgreSQL；前端 React 18 + TypeScript。
**外部依赖**：消息网关（HTTP + SSE）、Agent 服务（Anthropic Messages API tool use 形状）——两者在开发/演示阶段**由我们自己模拟实现**。

**交付**：GitHub public repo（保留 git 历史）+ README（如何跑起来）。48 小时内完成，题量大，做到哪算哪。

---

## 1. 系统架构与边界

```
        控制台前端 (React 18 + TS + Vite)
              │ REST + WebSocket
        后端 (Node + TS + PostgreSQL)
         ├── 账号管理
         ├── 群、成员与消息时间线
         ├── 定时序列
         └── Agent 接入
              │                          │
         消息网关（见 §3.1）         Agent 服务（见 §3.2）
```

我们负责交付的部分：

| 组件 | 说明 |
|---|---|
| 后端服务 | 对外暴露 §4 的 REST/WS API；对内对接网关与 Agent 服务 |
| 前端控制台 | §7 的 5 个页面 |
| 消息网关模拟器 | 必须忠实实现 §3.1 的全部接口、时序与故障行为（含 429/403/401/504/503、乱序、重复投递、断流） |
| Agent 服务模拟器 | 必须能按需复现 §3.2 列出的全部"坏行为"（坏 JSON、未知工具、重复 tool_use.id、慢响应、不返回等） |
| PostgreSQL schema | 通过 migration 管理，可重复执行 |

**部署约束（来自 `CLAUDE.md`）**：整体用 docker-compose 一键部署；测试脚本可跑在宿主机，但尽量只调用容器服务。

---

## 2. 贯穿全局的总则（最高优先级）

> 原文：**"下面每一条行为，在服务任意时刻重启前后都必须成立。"**

这是整个项目的核心难度来源，所有功能设计都要围绕它。拆解为以下不变量：

| 编号 | 不变量 |
|---|---|
| INV-1 | 任何时刻崩溃重启，不能出现"网关发出了消息、数据库里却没有记录" |
| INV-2 | 同一条出站消息在网关里不能对应多条消息（不重复发送） |
| INV-3 | 已对外产生效果的工具调用（发消息、移除成员），重启后不能重复执行，也不能被记成失败 |
| INV-4 | 停机/断流期间网关产生的事件，恢复后都要被处理到（at-least-once 消费 + 从 `since` 补拉） |
| INV-5 | 推给前端的状态事件，必须对应**已经持久化**的状态 |
| INV-6 | 状态变更与它的后果（移出群、取消排队消息、跳过序列步骤）要么都生效，要么都不生效（原子性） |
| INV-7 | 同一群同一时刻至多一个 `running` 的 agent run；至多一个 `running` 的序列运行——**多实例部署下也成立** |

---

## 3. 外部服务契约（需要模拟实现）

### 3.1 消息网关

**账号**
- 账号由我们在 migration/seed 中预置，初始 `status = idle`、`platformUserId = null`。
- `POST /accounts/:accountId/connect` → `{ platformUserId }`；同一 `accountId` 每次 connect 返回同一个 `platformUserId`。
- `POST /accounts/:accountId/disconnect` → 账号离线；离线账号的 `send`/`join`/`promote`/`kick`/`leave` 返回 `409 ACCOUNT_OFFLINE`。
- **补投**：离线账号之前发过的消息可能之后通过事件流补投，补投事件带新的（更大的）`eventId`，但 `msgId`/`sentAt` 为原值 → 其 `sentAt` 可能远早于已收消息，**不受 1 秒乱序窗口限制**。
- 网关主动推 `account_status` 事件：`{ accountId, status: 'suspended' | 'session_expired' }`；进入这两种状态后网关会自动把账号移出所有群并推 `member_left`。

**群与成员**
- `POST /groups { creatorAccountId }` → `{ groupId }`。创建者即群主，响应返回时已是成员，**网关不会为它推 `member_joined`**。
- `POST /groups/:groupId/invite` → `{ inviteLink, readyAfterMs }`。`readyAfterMs` 可能为 0 或几秒，期间使用链接 → `409 INVITE_NOT_READY`；链接可能任意时刻过期 → `410 INVITE_EXPIRED`，需重新申请。
- `POST /groups/:groupId/join { accountId, inviteLink }` → `202 { accepted: true }`（仅表示受理）；真正入群以随后的 `member_joined` 为准（通常 100–1500ms，**也可能永远不来**）。已在群内再 join → `409 ALREADY_MEMBER` 且不推 `member_joined`。
- `POST /groups/:groupId/promote { byAccountId, accountId }` → `200 {}`。`byAccountId` 必须是群主，否则 `403 NO_PERMISSION`；对方 `member_joined` 前调用 → `409 NOT_MEMBER_YET`。**promote 不推事件**。
- `POST /groups/:groupId/kick { byAccountId, targetPlatformUserId }` → `200 { kicked: true }`；目标在 200 返回前已从成员列表移除，随后推 `member_left`。群主已退群后任何 kick → `409 OWNER_LEFT`；非群主且未被 promote → `403 NO_PERMISSION`。响应可能需 1–5 秒，也可能返回 `504 NETWORK_TIMEOUT`（结果未知，网关保证 2 秒内收敛，可用成员列表判断）。
- `POST /groups/:groupId/leave { accountId }` → `200`，随后 `member_left`；也可能返回 `500`（没退成）。
- `member_joined` / `member_left` 事件：`{ groupId, platformUserId }`；**外部用户（非服务账号）进出群也会推**。
- `GET /groups/:groupId/members` → `[{ platformUserId }]`。账号实际进出群的那一刻成员列表就已变化，事件在其后推出。

**发消息**
- `POST /groups/:groupId/send { accountId, clientMsgId, text }` → `202 { accepted: true }`（202 本身可能延迟 1–2 秒返回）。真正发出以 `message_sent { clientMsgId, msgId, sentAt }` 为准（通常 50–2000ms）；也可能收到 `message_failed { clientMsgId, code }`。
- 同步错误码表：

| 码 | 含义 | 补充 |
|---|---|---|
| `429 RATE_LIMITED` | 该账号被限流 | 带 `retryAfterSeconds`；等待期内任何 send 都再得同样错误，**并且计时重置** |
| `403 ACCOUNT_SUSPENDED` | 账号被平台停用 | 之后该账号所有请求（含 connect）都返回同样错误；网关**可能不保证**再推一条 `account_status` |
| `401 SESSION_EXPIRED` | 会话失效，永久不可用 | 同上，之后所有请求都返回同样错误 |
| `403 GROUP_WRITE_FORBIDDEN` | 群不可写（被解散或禁言） | 与账号无关 |
| `403 SENDER_NOT_IN_GROUP` | 账号不在该群 | |
| `409 ACCOUNT_OFFLINE` | 未 connect 或已 disconnect | |
| `504 NETWORK_TIMEOUT` | 结果未知 | 见下 |
| `503`（任何端点） | 整体不可用 | 含 by-client-id 查询 |

- **504 的处理依据**：`GET /groups/:groupId/messages/by-client-id/:clientMsgId` → `200 { msgId, sentAt }` / `404`；同一 `clientMsgId` 落地多条时返回**最早的一条**。若 504 时消息其实已被接收，网关会在 2 秒内落地并推 `message_sent`；504 后超过 2 秒仍是 404 → 可确定没发出。
- **网关不按 `clientMsgId` 去重**：同一 `clientMsgId` 发两次 → 发出两条。（所以幂等是我们自己的责任）

**事件流**
- `GET /events?since=<eventId>`（SSE）。帧格式 `id: <eventId>` / `event: <type>` / `data: <JSON>`。
- `type ∈ message | message_sent | message_failed | member_joined | member_left | account_status`；`data` 中同时带 `eventId` 与 `type`。
- `eventId` 全局单调递增；`since` **独占**（返回 `eventId > since`）；网关保留全部历史事件。
- 投递语义 **at-least-once**：同一事件可能重复推送；相邻事件可能乱序（**乱序窗口 ≤ 1s**）。
- `message` 事件：`{ groupId, msgId, senderPlatformUserId, text, sentAt, mediaUrl? }`。**包含服务账号自己发出的消息**（其 `msgId` 与对应 `message_sent` 的相同），网关不区分消息来源。`sentAt` 毫秒精度，同毫秒可能多条。`mediaUrl?` 指向 `GET /media/:id`，过期返回 `404`。
- 连接可能随时断开；重连带 `since` 可补拉，不带则从当前时刻开始。
- 事件流**从服务启动那一刻就会推送**，与是否 connect 过账号无关。

### 3.2 Agent 服务

扮演"只能通过工具调用与外界交互的大脑"。协议为 Anthropic Messages API 的 tool use 形状：`content` 是块数组；`tool_result` 放在 `role: "user"` 消息里；用 `stop_reason` 区分。

**`POST /agent/turn`**
```jsonc
{
  "runId": "…",              // 由我们生成，与 GET /api/agent-runs/:id 的 id 相同
                             // Agent 服务按 runId 维护会话状态，同一 run 的所有请求必须用同一 runId
  "tools": [ { "name", "description", "input_schema" } ],  // 必须恰好是 4 个；input_schema 合法 JSON Schema
                                                            // 且 required 覆盖全部入参，否则 400 TOOLS_INVALID
  "messages": [ /* 见下方形状 */ ]
}
→ 200 { "stop_reason": "tool_use", "content": [ { "type": "tool_use", "id": "tu_2", "name": "…", "input": {…} } ] }
→ 200 { "stop_reason": "end_turn", "content": [ { "type": "text", "text": "…" } ] }
```
- **合法响应每轮恰好一个块**。`tool_result` 的 `is_error` 可省略（省略视为 false）。
- **`BAD_JSON` 协议错误的三种情形**：① 返回非 2xx；② 响应体不是合法 JSON（**外面套 markdown 代码围栏、或前后夹着文字，也算不合法**）；③ JSON 合法但形状不符（缺 `stop_reason`、块数 ≠ 1、`stop_reason` 与块类型不一致）。

**`POST /agent/audit { text, groupId }`** → `200 { verdict: "pass" | "fail", reason }`

**触发上下文**（`messages[0]` 的 text，JSON 串）：
```json
{ "groupId": "…",
  "triggerMessages": [ { "msgId", "senderPlatformUserId", "text", "sentAt" } ],
  "policy": { "autoKickEnabled": false },
  "ownPlatformUserIds": [ "…" ] }
```
`triggerMessages` 按 `sentAt` 升序。

**四个工具（名字与入参固定，必须恰好这 4 个）**

| 工具 | 入参 | 成功时 tool_result 的 content（JSON 串） | 备注 |
|---|---|---|---|
| `get_recent_messages` | `{ limit: number }` | `{ messages: [{ msgId, senderPlatformUserId, isOwn, text, sentAt }], truncated }` | 按 `sentAt` 升序；包含触发消息本身和 run 期间新到的消息；`limit` 上限 50（超出按 50 处理）；单条 `text` > 500 字截断并置 `truncated: true` |
| `send_message` | `{ text: string, idempotency_key: string }` | `{ clientMsgId, deliveryStatus }` | 在该消息变为 `accepted` 或 `sent` 后返回（最多等 5 秒）。`failed` 时返回错误：群不可写 → `GROUP_UNREACHABLE`；账号停用/失效/中途变终态 → `SEND_FAILED`；5 秒仍无法确认 → `SEND_TIMEOUT` |
| `kick_user` | `{ platform_user_id: string, reason: string }` | `{ kicked: true }` | |
| `finish` | `{ summary: string }` | 记一步 `{ ok: true }` | 不再调 `/agent/turn` |

**错误 tool_result**：`is_error: true`，content 为 JSON 串 `{ "code", "message", "hint"? }`。码表（12 个）：
`UNKNOWN_TOOL` / `INVALID_INPUT` / `DUPLICATE_TOOL_USE_ID` / `BAD_JSON` / `TURN_TIMEOUT` / `AUDIT_REJECTED` / `POLICY_DENIED` / `SEND_TIMEOUT` / `SEND_FAILED` / `NO_AVAILABLE_ACCOUNT` / `GROUP_UNREACHABLE` / `OWNER_LEFT` / `NO_PERMISSION`

- Agent 服务根据 `is_error` 与 `code` 决定下一步；`message`/`hint` 供模型理解。
- 它的重试会使用**新的** `tool_use.id`；**`tool_use.id` 重复时先按协议错误处理**。

**结束**：收到 `finish` → run `finished`，`endReason = final`，`input.summary` 存为 run 的 `summary`。收到 `stop_reason: end_turn` → 同样结束，`text` 存为 `summary`，**不发到群里**。

**Agent 服务可能出现的行为（模拟器需能复现）**
- 响应体不是合法 JSON / 套 markdown 围栏 / 前后夹文字。
- 调用不在 `tools` 里的工具；或入参不符合 `input_schema`。
- 同一个 `tool_use.id` 用两次。
- 拿到 `send_message` 结果后（尤其 `SEND_TIMEOUT`），用同一 `idempotency_key` 再调一次 `send_message`。
- 一直调工具不结束；或连续多次用同样入参调 `get_recent_messages`。
- 调 `get_recent_messages { limit: 100000 }`。
- 响应很慢（约 8 秒，或更久，甚至不返回）。
- `audit` 端点：返回 `500`；或 `200` 但 body 非法 JSON / 没有 `verdict` / `verdict` 是别的值；或响应很慢、不返回。

---

## 4. 我们对外暴露的 API（端点与字段名必须按约定）

**配置**：环境变量 `PORT` / `DATABASE_URL` / `GATEWAY_URL` / `AGENT_URL`。

**字段约定**
- 时间字段：ISO 8601 UTC 字符串（如 `2026-09-26T08:00:00.000Z`），无值为 `null`。
- 错误响应统一：`{ error: { code, message, requestId, ...业务字段 } }`。
- `401` → `code = UNAUTHORIZED`；`403` → `code = FORBIDDEN`。

| 端点 | 说明 |
|---|---|
| `POST /api/auth/login { username, password }` → `{ accessToken }` | 预置用户 `admin/admin`（全部权限）、`viewer/viewer`（只读）；access token 有效期 **15 分钟** |
| `GET /api/health` → `{ ok, schemaVersion }` | |
| `GET /api/accounts` → `[{ id, status, platformUserId, rateLimitedUntil }]` | |
| `POST /api/accounts/:id/connect` → `200 { status, platformUserId }` | 调网关 connect，保存 `platformUserId`，`idle`/`disconnected` → `online` |
| `POST /api/accounts/:id/transition { to, expectedFrom }` → `200 { status }` / `400 VALIDATION_ERROR` / `404 ACCOUNT_NOT_FOUND` / `409 ILLEGAL_TRANSITION` / `409 CAS_CONFLICT` | `expectedFrom` 必填；转移表见 §5.1；标为 `disconnected`/`idle` 时调网关 `disconnect` |
| `POST /api/groups { creatorAccountId, memberAccountIds[] }` → `202 { jobId }` / `422 ACCOUNT_NOT_ONLINE` / `400 VALIDATION_ERROR` | 建群 + 拉人 + 把 `memberAccountIds[0]` 提升为管理员；所有账号必须 `online`；`memberAccountIds` ≥ 1 且不含群主；新群默认 `agentEnabled = false`、`autoKickEnabled = false` |
| `GET /api/groups` · `GET /api/groups/:id` | `{ id, gatewayGroupId, status, creatorAccountId, agentEnabled, autoKickEnabled, members: [{ accountId, platformUserId, role }], activeSequenceRunId, activeAgentRunId }` |
| `PATCH /api/groups/:id { agentEnabled?, autoKickEnabled? }` → `200` | |
| `POST /api/groups/:id/send { accountId, text }` → `202 { clientMsgId }` / `409 ACCOUNT_NOT_IN_GROUP` / `409 ACCOUNT_UNAVAILABLE` | 账号 `idle`/`disconnected`/终态 → `409 ACCOUNT_UNAVAILABLE`；`rate_limited` 时照常受理、保持 `queued`，到期后按顺序发出 |
| `POST /api/groups/:id/leave-all` → `202 { jobId }` | 见 §6.2 |
| `GET /api/jobs/:jobId` → `{ status: running \| finished \| failed, errors: [{ step, code }] }` | `errors` 非空即 `failed`；`step ∈ create \| invite \| join:<accountId> \| promote \| leave:<accountId>` |
| `GET /api/groups/:id/messages?before=<cursor>&limit=50` → `{ items: [...], nextCursor }` | item: `{ msgId, clientMsgId, senderPlatformUserId, isOwn, text, sentAt, deliveryStatus, failCode }`；按 `sentAt` 倒序 |
| `GET /api/agent-runs/:id` | `{ id, groupId, status, endReason, summary, steps: [{ kind, toolUseId, name, input, resultSummary, isError, errorCode, auditVerdict, rawResponse }] }` |
| `GET /api/groups/:id/agent-runs` | 最近的运行列表（可不含 steps） |
| `POST /api/sequences`（序列 JSON）→ `{ id }` | 格式见 §6.1 |
| `POST /api/groups/:id/sequence-runs { sequenceId, vars, stepVars }` → `201 { runId }` / `409 SEQUENCE_ALREADY_RUNNING` / `422 UNRESOLVED_PLACEHOLDER` | 422 时带 `stepIndex`、`key` |
| `GET /api/sequence-runs/:id` → `{ status, currentStepIndex, steps: [{ index, status, scheduledAt, sentAt, clientMsgId, resolvedVars, varSources }] }` | |
| `WS /ws` | 连接后先发 `{ type: 'auth', accessToken, sinceSeq? }`，服务端回 `{ type: 'auth', success: true }` 后推事件；帧 `{ seq, type, payload }`，`seq` 全局单调递增；带 `sinceSeq` 从其后补发（可选，见 §6.4） |

**枚举/字段细则**
- 群 `status: active | unreachable | left`（`leave-all` 完成后 `left` 且 `members = []`）。
- 成员 `role: creator | admin | member`（建群后创建者为 `creator`，`memberAccountIds[0]` 为 `admin`，其余 `member`）。
- `activeAgentRunId` 仅在有 `running` 的 run 时非空；`activeSequenceRunId` 同理。
- 消息 `deliveryStatus: queued | accepted | sent | failed | unknown | cancelled` —— **仅对自己的消息有意义**。自己的消息从 `queued` 起就在列表里（`sentAt` 先用受理时刻，发出后改为网关的 `sentAt`），**一条消息只有一行**。`failed`/`cancelled` 时 `failCode` 必填（网关错误码，或 `ACCOUNT_TERMINAL` / `GROUP_UNREACHABLE`）。
- agent run `status: running | finished | failed | blocked | cancelled`；
  `endReason`（仅非 running 时有值）：`final → finished`；`budget_exhausted | wall_clock | protocol_errors → failed`；`audit_blocked → blocked`；`cancelled → cancelled`。
  step `kind: tool_use | final | protocol_error`（协议错误步的 `toolUseId`/`name`/`input` 为 `null`）；`rawResponse` 为 Agent 服务原始响应体、**截断到 2KB**；`isError = true` 时 `errorCode` 必填；`resultSummary` ≤ 200 字。
- 序列 run `status: running | finished | failed | stopped`（`stopped` = 群变 `unreachable`）；步骤 `status: pending | accepted | sent | skipped | failed`。

**WS 事件 `type` 至少包括**
`account_status_changed { accountId, from, to }`、`account_terminal { accountId, status }`、`inconsistency { kind, ref, message }`、`message { groupId, msgId, isOwn }`、`agent_run { runId, groupId, status, endReason }`、`sequence_run { runId, groupId, status, currentStepIndex }`。

---

## 5. A 组需求（核心，必须做）

### A0 基础
- 数据库迁移**可重复执行**；**数据库 schema 落后于代码时服务拒绝启动**。
- 错误响应格式见 §4。
- `login` 返回 access token；`viewer` 对**所有写操作**得到 `403`。

### A1 账号状态

**状态转移表**（行 = 当前，列 = 目标；✔ 为合法）

| 从 \ 到 | idle | online | rate_limited | disconnected | suspended | session_expired |
|---|---|---|---|---|---|---|
| **idle** | | ✔ | | | ✔ | ✔ |
| **online** | ✔ | | ✔ | ✔ | ✔ | ✔ |
| **rate_limited** | | ✔ | | ✔ | ✔ | ✔ |
| **disconnected** | ✔ | ✔ | | | ✔ | ✔ |
| **suspended** | | | | | | |
| **session_expired** | | | | | | |

- `suspended` / `session_expired` 是**终态**，没有出边，重连也不能恢复。重复进入同一终态**静默忽略**，不影响后续事件处理。
- 表上没有的转移（**包括同状态到同状态**）一律 `ILLEGAL_TRANSITION`。
- `rateLimitedUntil` 的刷新**不算**状态转移。
- 并发变更同一账号时至多一个成功，另一个得 `409 CAS_CONFLICT`，**不能后写覆盖先写**（比较并交换）。
- **进入终态时的原子后果**（无论来源是发送错误、网关事件还是操作员标记，结果都一样）：
  1. 该账号从所有群的成员表中移除；
  2. 它**排队中的发送**变为 `cancelled`（`failCode = ACCOUNT_TERMINAL`）；
  3. 对应的**序列步骤**变为 `skipped`；
  4. 推 `account_terminal` 事件。
- 推给前端的状态事件必须对应**已经保存**的状态。
- `rate_limited` 由 `RATE_LIMITED` 触发，`retryAfterSeconds` 后**自动回到 `online`**；到期时若账号已不是 `rate_limited`（例如已被操作员标记离线）则不做转移。

### A2 网关接入
- 出站消息在库里有记录与 `deliveryStatus`：`queued → accepted → sent | failed | unknown | cancelled`。满足 INV-1、INV-2。
- **504 处理细则**：收到 → `unknown`；**从收到 504 起 5 秒内**必须变为 `accepted`/`sent`/`failed` 之一。确认没发出时可用同一 `clientMsgId` 重发**一次（总共只允许一次）**；重发后仍未发出 → `failed`（`failCode = NETWORK_TIMEOUT`）。**确认没有发出之前不能重发**。by-client-id 查询不可用期间保持 `unknown`，恢复后 2 秒内确定状态。
- 入站 `message` 事件按 `(groupId, msgId)` 去重，按 `sentAt` 排序展示。
- 服务账号自己发出的消息回流 → `isOwn = true`，**不触发 agent**。
- 处理网关事件时若自身 DB 写入失败：**不能让事件处理中断，也不能让事件内容丢失**；同时推 `inconsistency` 事件让操作员看到。
- 停机/断流期间的事件，恢复后都要处理到（INV-4）。
- **错误处理表**：

| 网关返回 | 处理 |
|---|---|
| `RATE_LIMITED` | 账号 → `rate_limited`；等待期内不再向网关发该账号的 `send`（`disconnect`/`leave` 不受限）；该账号排队消息保持 `queued`，到期后按原顺序发出；序列步骤顺延，不跳过 |
| `ACCOUNT_SUSPENDED` | 账号 → `suspended`（触发终态后果） |
| `SESSION_EXPIRED` | 账号 → `session_expired`（触发终态后果） |
| `GROUP_WRITE_FORBIDDEN` | 群 → `unreachable`；该群的序列运行 → `stopped`，agent 不再触发，正在运行的 agent run 在当前步后 `cancelled`；**账号状态不变** |
| `SENDER_NOT_IN_GROUP` / `ACCOUNT_OFFLINE` | 该条 `failed`（`failCode` 为同名码）；账号、群状态不变 |
| `NETWORK_TIMEOUT` | 见上 |
| `NOT_MEMBER_YET` | 建群完成时 `memberAccountIds[0]` 已是管理员，对 promote 的调用总数 ≤ 2；`member_joined` 超过 10 秒未到 → job `failed`，`errors[].code = JOIN_TIMEOUT` |
| `OWNER_LEFT` / `NO_PERMISSION` | `kick_user` 返回同名错误；账号、群状态不变 |

（`INVITE_NOT_READY` / `INVITE_EXPIRED` / `ALREADY_MEMBER` 见 §6.2）

### A3 建群
- 流程：网关建群 → 申请邀请链接 → 各成员 join → 等 `member_joined` → 把 `memberAccountIds[0]` 提升为管理员。**异步执行**，`GET /api/jobs/:jobId` 可看进度与失败步骤。
- 成员表写入时机：创建者在**建群成功后**写入（`role = creator`）；其他成员在**收到 `member_joined` 后**写入。

### A4 消息时间线与实时推送
- 消息列表按**游标分页**。"加载更早"时即使同时有新消息写入，**不能出现重复或遗漏**。
- WebSocket 认证通过后推送事件，`seq` 单调递增。

### A5 Agent 接入（12 条）

1. **触发**：`agentEnabled=true` 的群里出现一条非自己的消息 → 创建一次 agent run。**同一群同一时刻至多一个 running 的 run（多实例部署时也成立，INV-7）**。run 进行期间到达的非自己消息记为**待处理**；run 结束时若有待处理消息，**立即创建下一次 run**，把这些消息**全部**放进 `triggerMessages`。
2. **循环与上限**：组装 `messages` → 调 `/agent/turn` → 校验响应 → 执行工具 → 追加 `tool_result` → 继续。**一步 = 一次 `/agent/turn` 往返**（无论返回什么）；**审计重试不算步**。上限：
   - **12 步**（含结束那一步）；
   - **60 秒**（从 run 创建起，含等审计时间；重启后从恢复时刻继续累计，**停机时间不计**）；
   - **连续 3 次协议错误**结束（任何一次合法响应清零）。
   - `/agent/turn` 每轮超时 **10–15 秒（可配）**，超时记一次协议错误（`TURN_TIMEOUT`），**超时后才到的响应丢弃**。
3. **协议错误分两类**：
   - **未知工具 / 入参不合 schema** → 正常追加 assistant 的 tool_use 块，再追加 `is_error: true` 的 tool_result（`UNKNOWN_TOOL` / `INVALID_INPUT`）。
   - **坏响应（`BAD_JSON`，定义见 §3.2）/ 重复 `tool_use.id` / 超时** → **不追加 assistant 块**，改为追加一条 `role: user` 的 text 块 `PROTOCOL_ERROR <code>: <一句话>`；这一步**计入步数**，记录在 `steps[]`（`kind = protocol_error`，`rawResponse` 为原始响应体）。
4. **审计**：`send_message` / `kick_user` 执行前必须经过 `/agent/audit`。
   - `send_message` 的 `text` = 待发文本；`kick_user` 的 `text` = `JSON.stringify({ action: 'kick', platform_user_id, reason })`。
   - 只有审计返回**合法 JSON 且 `verdict` 恰为 `pass`** 才执行。`fail` → 不执行，返回 `AUDIT_REJECTED`。
   - 拿不到明确结论时（含超时），对**同一次工具调用最多尝试 3 次**（耗时计入 60 秒；**单次失败不返回给 agent、不计步**）；3 次都拿不到 → run `blocked`，`endReason = audit_blocked`，**该工具不执行**，推事件通知操作员。
5. **执行账号**：选哪个账号由我们决定（只能用 `online` 的群成员；`kick_user` 需 `role ∈ {creator, admin}`）。没有可用账号 → `NO_AVAILABLE_ACCOUNT`（**不算协议错误，计入步数**）。账号在执行中途变终态 → 该步 `SEND_FAILED`，**run 继续**。
6. `kick_user` 还要求群 `autoKickEnabled = true`，否则返回 `POLICY_DENIED`。
7. **幂等**：同一个 run 里相同 `idempotency_key` 的 `send_message`，第二次及以后**不再发送、不再审计**，返回那条消息的**当前状态**。被 `AUDIT_REJECTED` / `POLICY_DENIED` 拒绝的调用**不算**用过这个 key。
8. **恢复**：服务在 run 进行中任意时刻重启，run 都要从中断处继续（**使用同一个 `runId`**）并正常结束；已产生对外效果的工具调用**不能再执行一次**，**也不能被记成失败**（INV-3）。
9. **结果大小**：单个 tool_result `content` ≤ **8KB**，超出截断并置 `truncated: true`；`resultSummary` ≤ 200 字。
10. **外部状态变化**：群变 `unreachable`、或 `agentEnabled` 被关闭时，正在运行的 run **在当前这一步结束后终止**，`endReason = cancelled`。
11. **重复调用**：模型连续用同样入参调 `get_recent_messages` 时的处理方式**由我们决定**；run 必须在 12 步内以合理方式结束。
12. **可查看**：每一步（含协议错误步）都在 `GET /api/agent-runs/:id` 里可见。

### A6 前端
见 §7 的页面 1–3。

---

## 6. B 组需求

### 6.1 B1 定时序列（含页面 5）

序列 JSON：
```json
{ "name": "…",
  "steps": [
    { "index": 1, "accountRole": "admin",  "text": "{event} 将于 {time} 开始，请提前准备", "delaySeconds": 10 },
    { "index": 2, "accountRole": "member", "text": "提醒：{event} 的资料已上传到 {location}", "delaySeconds": 5 }
  ] }
```

- **账号选择**：`admin` → 群里 `role ∈ {creator, admin}` 且 `online` 的账号（**优先 `admin`**）；`member` → `role = member` 且 `online` 的账号中按 `accountId` **字典序取第一个**。没有匹配账号 → 该步 `skipped`。**`rate_limited` 的账号不算"没有"**，该步顺延到限流结束后发。
- **启动参数**：`vars`（key-value）+ `stepVars`（按步，如 `{ "2": { "location": "共享盘/第二季度" } }`）。文本里 `{key}` 在**发送时**解析；key 匹配 `[A-Za-z0-9_]+`。
- **取值规则**：开始时 = `vars`；某步在 `stepVars` 给了值，**从这一步起后续步骤都用新值**，直到更晚的步骤再次给值；`stepVars` 里的 `""` **表示这一步不改**；`vars` 里的 `""` **视为未提供**。
- **预检**：启动前检查所有步骤，任何 `{key}` 解析不到 → `422 UNRESOLVED_PLACEHOLDER`，**一条都不发，也不留下运行中的记录**（之后可正常启动）。
- `GET /api/sequence-runs/:id` 每步 `resolvedVars` 为**最终取值**；`varSources` 标每个 key 来自 `default`（即 `vars`）还是 `step:<index>`——**沿用前面某步的值时，标最初给出它的那一步**。
- **互斥**：同一群同一时刻至多一个 `running` 的序列运行；并发两次启动，**恰好一个 `201`、一个 `409 SEQUENCE_ALREADY_RUNNING`**。
- **排期**："发出"指收到 `message_sent` 的时刻。第 1 步在启动后 `delaySeconds` 秒发送；第 n 步在第 n-1 步**发出后** `delaySeconds` 秒发送；**跳过的步骤视为在跳过时刻"发出"**。
- 跳过的步骤 `status = skipped`，**有时间戳**，进度照常推进。
- **重启后**：只重排**最早一个已过期的步骤**（重启时刻 + 该步 `delaySeconds`），后续步骤仍按"前一步发出后"排期，**不能一次性全部发出**。

### 6.2 B2 群生命周期
- **建群时**：`INVITE_NOT_READY` → 等到 `readyAfterMs` 后重试；`INVITE_EXPIRED` → 重新申请链接后**重试一次**，群和账号状态都不变；`ALREADY_MEMBER` → **视为成功**，直接 promote。
- **`leave-all`**：群里所有服务账号退群，**群主最后退**（群主先退的话，剩下的账号无法再操作）。非群主账号退群失败 → 记入 `errors[]`，**其余非群主账号继续退，群主不退**，job `failed`；失败的账号在我们数据库和网关里**都仍是成员**。
- 完成后，我们数据库里的成员表与网关的成员列表**一致**。

### 6.3 B3 登录会话
- refresh token **只通过 HttpOnly cookie 下发，不放在响应体里**；`POST /api/auth/refresh`（读 cookie）→ `{ accessToken }` + **新的 `Set-Cookie`**。
- refresh token **每次使用后轮换**；**旧的再被使用 → `401`，并且整个会话作废**：之前换出的新 refresh token 和新 access token 都**立即失效**。
- `POST /api/auth/logout` 之后，**同一个 access token 立即失效**。
- 前端：access token 过期后**自动续期**；多个请求同时遇到 401 时**只发一次 refresh**。

### 6.4 B4 断线补齐与 agent 步骤详情
- 前端断线期间发生的事件，重连后 **3 秒内**出现在页面上，且**不重复**。
- 见 §7 页面 4。

---

## 7. 前端需求

React 18 + TypeScript + Vite，UI 库/状态库自选。**不需要 i18n、主题切换、响应式**。

| # | 页面 | 要点 |
|---|---|---|
| 1 | **登录** | `viewer` 登录后看不到写操作按钮 |
| 2 | **账号列表** | 显示状态；"标记离线""重连""释放账号"三个按钮**只在对应转移合法时出现**；`viewer` 看不到这些按钮，**直接调接口也得到 `403`** |
| 3 | **群详情** | 成员列表（含 role）；消息时间线（"加载更早"；实时追加；自己的消息显示 `deliveryStatus`）；该群最近 agent run 列表（状态、endReason），**`blocked` 的 run 醒目提示** |
| 4 | **Agent 运行详情** | 每一步的 `kind`、工具名、入参、结果摘要、审计结论、错误码；**协议错误步可查看原始响应体** |
| 5 | **序列运行** | 选序列、填 `vars`/`stepVars` → **预检弹窗**（每步每个 key 的最终取值与来源）→ 启动；运行中显示进度；预检不通过时显示 `stepIndex` 和 `key` |

---

## 8. C 组（选做）

- **C1 媒体文件**：`message` 事件带 `mediaUrl` 时，把文件下载到本地 `media/`，路径记在消息的 `localFilePath`；定期删除超过 N 天（可配，默认 **30**）的文件。删除后**不能留下指向已删文件的记录**；**仍被运行中的 agent run 用到的文件不删**。
- **C2 接入真实 LLM**：用 Claude 或 Gemini（自备 key）实现独立服务，对外接口与 §3.2 **完全相同**，后端只改 `AGENT_URL` 即可切换。
- **C3 端到端测试**：Playwright，登录 → 打开群 → 看到 agent run 的步骤。

---

## 9. 验收场景（S1–S8）

| # | 场景 | 外部服务表现 | 期望结果 |
|---|---|---|---|
| S1 | 受理与发出 | 网关对 send 先回 202，过一会儿再推 `message_sent` | `message_sent` 之前 `deliveryStatus = accepted`，之后为 `sent` |
| S2 | 事件重复 | 网关把每个事件都推两次 | 时间线无重复行；agent 不被重复触发 |
| S3 | 自己的消息回流 | 网关把服务账号发出的消息作为 `message` 事件推回 | `isOwn = true`；**不产生新的 agent run** |
| S4 | 限流 | 网关对 send 回 `429 RATE_LIMITED { retryAfterSeconds: N }` | 账号进入 `rate_limited`；到期前网关收不到该账号的 `send`；到期自动恢复 |
| S5 | Agent 重试同一个 key | 网关对第一次 send 回 504、1.5 秒后消息落地；Agent 拿到结果后用同一 `idempotency_key` 再调一次 | 网关里**恰好一条**消息；第二次调用返回这条消息当前状态（`sent`），**不再调审计**；run 正常结束 |
| S6 | Agent 坏响应 | Agent 依次返回坏 JSON、一个未知工具调用，然后正常结束 | run 以 `final`/`budget_exhausted`/`protocol_errors` 之一结束；服务不崩；每一步都有 `kind` 和 `rawResponse` |
| S7 | 序列并发启动 | — | 并发两次启动，恰好一个 `201`、一个 `409` |
| S8 | 序列预检 | — | 第 3 步有解析不了的占位符 → `422`，`error.code = UNRESOLVED_PLACEHOLDER`，`error.stepIndex = 3`，`error.key` 为该占位符名；**网关收不到任何消息** |

---

## 10. 需求分组汇总与实现优先级

| 组 | 内容 | 优先级 | 说明 |
|---|---|---|---|
| **A0** | 迁移、启动校验、错误格式、鉴权 | P0 | 地基 |
| **A2** | 网关接入（事件消费、出站投递状态机、504/429/终态处理） | P0 | 最难、最核心 |
| **A1** | 账号状态机 + CAS + 终态原子后果 | P0 | 依赖 A2 |
| **A3** | 建群（异步 job + 邀请链接 + promote） | P1 | |
| **A4** | 时间线分页 + WS 推送 | P1 | |
| **A5** | Agent 接入（触发、循环、审计、幂等、恢复） | P0 | 难度最高 |
| **B1** | 定时序列 | P1 | 规则细节多 |
| **B2** | 群生命周期（leave-all） | P1 | |
| **B3** | 登录会话（refresh 轮换 + 复用检测） | P1 | |
| **B4** | 断线补齐 | P2 | |
| **前端 1–5** | 控制台 | P1 | 页面 2/3/5 是必看项 |
| **C1/C2/C3** | 选做 | P3 | 时间富余再做 |

---

## 11. 难点与风险清单

| # | 难点 | 风险点 |
|---|---|---|
| 1 | **崩溃安全**（INV-1/2/3） | 需要在发网关请求**之前**先落库（出站记录 + `clientMsgId`），并让"发送"这一步可重放而不重复发 |
| 2 | **504 的未知态收敛** | 5 秒内必须定态；by-client-id 不可用时要保持 `unknown` 并后续重查；重发**只允许一次**且必须在确认未发出之后 |
| 3 | **事件去重与乱序** | 重复事件（S2）+ ≤1s 乱序 + 任意早的补投 `sentAt`；去重键是 `(groupId, msgId)` 而非 `eventId` 顺序 |
| 4 | **事件处理不丢** | 自身 DB 写失败时要保留事件内容并推 `inconsistency`，不能中断消费 |
| 5 | **单 run 互斥（多实例）** | 需要 DB 级锁（如 advisory lock 或 partial unique index），不能只用进程内状态 |
| 6 | **终态原子后果** | 状态变更 + 移出群 + 取消排队消息 + 跳过序列步骤，必须同一事务 |
| 7 | **Agent run 恢复** | 重启后用同一 `runId` 继续；已产生效果的工具调用不能重放也不能记失败 → 需要 per-step 持久化 + 幂等键 |
| 8 | **审计重试语义** | 最多 3 次、不计步、单次失败不返回给 agent；3 次失败 → `blocked` |
| 9 | **协议错误分类** | `UNKNOWN_TOOL`/`INVALID_INPUT` 要追加 assistant 块；`BAD_JSON`/重复 id/超时**不追加**，改追加 user text 块——两种处理方式不同 |
| 10 | **序列取值/来源追踪** | `stepVars` 的"黏性"语义 + `""` 的两种含义 + `varSources` 标"最初给出值的步骤" |
| 11 | **序列重启排期** | 只重排最早一个过期步骤，其余仍相对前一步 |
| 12 | **refresh token 复用检测** | 轮换 + 复用即整个会话作废（含已换出的新 token 与新 access token） |
| 13 | **游标分页无重复无遗漏** | 新消息并发写入时的游标稳定性（建议 `(sentAt, msgId)` 复合游标） |
| 14 | **模拟器保真度** | 网关/Agent 模拟器必须能复现全部故障行为，否则验收场景（S1–S8）跑不出来 |

---

## 12. 交付物

- 代码仓库（**保留 git 历史**）。
- README：说明如何把项目跑起来。
- 按 `CLAUDE.md`：docker-compose 一键部署；测试脚本尽量只调用容器服务。

---

## 13. 自测清单（按需求编号）

- [ ] 迁移可重复执行；schema 落后时拒绝启动（A0）
- [ ] `viewer` 所有写操作 403；`401 → UNAUTHORIZED`、`403 → FORBIDDEN`（A0）
- [ ] 状态转移表全枚举验证，含同状态转移 → `ILLEGAL_TRANSITION`（A1）
- [ ] 并发 transition 只有一个成功，另一个 `CAS_CONFLICT`（A1）
- [ ] 终态四种来源结果一致，且原子（A1）
- [ ] `rate_limited` 到期自动恢复；到期前 send 不发（A1/A2）
- [ ] 出站消息状态机全路径：`queued→accepted→sent`、504→`unknown`→定态、重发仅一次（A2）
- [ ] `(groupId, msgId)` 去重；乱序与补投正确排序（A2）
- [ ] 自身消息回流 `isOwn=true` 且不触发 agent（A2/S3）
- [ ] 事件重复推两次不产生重复行、不重复触发 agent（S2）
- [ ] DB 写失败时事件不丢 + `inconsistency` 推送（A2）
- [ ] 停机期间事件恢复后被处理（INV-4）
- [ ] 建群全流程 + `JOIN_TIMEOUT` + promote 调用 ≤ 2 次（A3/A2）
- [ ] 游标分页并发写入无重复无遗漏（A4）
- [ ] WS 认证 + `seq` 单调递增（A4）
- [ ] Agent 触发/待处理消息排队/run 结束立即再触发（A5.1）
- [ ] 12 步、60 秒、连续 3 次协议错误（A5.2）
- [ ] `/agent/turn` 超时 → `TURN_TIMEOUT`，晚到响应丢弃（A5.2）
- [ ] 两类协议错误的不同追加方式（A5.3）
- [ ] 审计：pass 才执行、fail → `AUDIT_REJECTED`、3 次失败 → `blocked`（A5.4）
- [ ] 执行账号选择、`NO_AVAILABLE_ACCOUNT`、中途终态 → `SEND_FAILED` 且 run 继续（A5.5）
- [ ] `POLICY_DENIED`（`autoKickEnabled=false`）（A5.6）
- [ ] 同 run 同 `idempotency_key` 幂等，且被拒的调用不算用过 key（A5.7 / S5）
- [ ] run 中途重启能继续且不重复副作用（A5.8）
- [ ] tool_result ≤ 8KB、`resultSummary` ≤ 200 字、`rawResponse` ≤ 2KB（A5.9）
- [ ] 群 `unreachable` / `agentEnabled` 关闭 → run 当前步后 `cancelled`（A5.10）
- [ ] 序列账号选择规则 + `skipped` + 顺延（B1）
- [ ] 预检 422 且不留下运行记录（B1/S8）
- [ ] `varSources` 追踪正确（B1）
- [ ] 序列并发启动 201/409（B1/S7）
- [ ] 序列重启只重排最早过期步骤（B1）
- [ ] `leave-all` 群主最后退、失败账号两边都仍是成员（B2）
- [ ] refresh 轮换 + 复用即全会话作废；logout 后 access token 立即失效（B3）
- [ ] 前端 401 单飞 refresh（B3）
- [ ] 断线重连 3 秒内补齐且不重复（B4）
- [ ] 前端 5 个页面全部可用，`viewer` 无写按钮（§7）
