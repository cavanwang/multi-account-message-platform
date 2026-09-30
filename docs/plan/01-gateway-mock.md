# 切片 1：消息网关模拟器

> 上游依据：`docs/examination_project.md` §2.1、`docs/requirements.md` §3.1
> 独立 commit：**是**。
> 前置：切片 0。
> 这是一个**独立 service**（单独容器 `gateway-mock`），后端只通过 `GATEWAY_URL` 走 HTTP 访问，不直接引用其代码。

---

## 1. 目标与范围

忠实实现题面 §2.1 的**全部接口、时序与故障行为**，让它成为后续所有切片与 S1–S8 验收场景的驱动器。

- 状态保存在内存（Map）即可，**进程重启清空**——题目未要求网关持久化，但需要在 README 写明。
- 所有时序数字必须**可通过环境变量或控制端点在"确定模式"下压缩**（如把 1–5 秒改成 50ms），否则 e2e 测试跑不动。**默认仍按题面时序**。
- 必须提供**确定性故障注入开关**，否则 S1–S8 无法复现。

**不在本切片内**：Agent 模拟器（切片 5 前置）；`GET /media/:id`（C1 选做，本切片只保留 `mediaUrl` 字段透传）。

---

## 2. 内部状态模型

```ts
Account   { accountId, status: idle|online|disconnected|suspended|session_expired,
            platformUserId: string|null, rateLimitedUntil?: number, retryAfterSeconds?: number }

Group     { groupId, creatorAccountId, ownerPlatformUserId,
            memberPlatformUserIds: Set<string>, writeForbidden: boolean, dissolved: boolean,
            invites: Map<inviteLink, { expiresAt: number|null, readyAt: number }> }

Message   { msgId, groupId, senderPlatformUserId, text, sentAt, clientMsgId?, mediaUrl? }

Event     { eventId, type, data }   // 全局单调递增，append-only，全部保留
```

- `platformUserId`：`connect` 时按 `accountId` **确定性派生**（如 `pu_<accountId 的稳定哈希>`），保证同一账号每次都拿到同一个。
- 事件同时追加进一个全局环形/数组（保留全部），供 `GET /events?since=` 补拉。

---

## 3. 对外契约

### 3.1 账号

| 端点 | 行为 |
|---|---|
| `POST /accounts/:accountId/connect` | 返回 `{ platformUserId }`；已 `suspended`/`session_expired` → 同码错误；`idle`/`disconnected` → `online`。幂等返回同一 `platformUserId` |
| `POST /accounts/:accountId/disconnect` | → `online` 变 `disconnected`；账号离线后 `send/join/promote/kick/leave` → `409 ACCOUNT_OFFLINE` |
| 事件 `account_status` | `{ accountId, status: 'suspended' \| 'session_expired' }`；进入后**自动移出所有群并推 `member_left`** |

- 离线账号此前发出的消息，`sentAt`/`msgId` 保持原值但 `eventId` 更大 → 补投时**不受 1s 乱序窗口限制**（该限制只在事件流推送侧体现）。

### 3.2 群与成员

| 端点 | 行为 |
|---|---|
| `POST /groups { creatorAccountId }` | → `{ groupId }`；创建者即群主且**已是成员**，**不推 `member_joined`** |
| `POST /groups/:groupId/invite` | → `{ inviteLink, readyAfterMs }`；`readyAfterMs` ∈ {0, 1–3s}；未 ready 使用 → `409 INVITE_NOT_READY`；过期 → `410 INVITE_EXPIRED` |
| `POST /groups/:groupId/join { accountId, inviteLink }` | → `202 { accepted: true }`（仅受理）；100–1500ms 后推 `member_joined`，**有概率永不推**；已在群内 → `409 ALREADY_MEMBER` 且不推事件 |
| `POST /groups/:groupId/promote { byAccountId, accountId }` | → `200 {}`；`byAccountId` 非群主 → `403 NO_PERMISSION`；对方尚未入群 → `409 NOT_MEMBER_YET`；**不推事件** |
| `POST /groups/:groupId/kick { byAccountId, targetPlatformUserId }` | → `200 { kicked: true }`；**200 前**目标已移出成员列表，随后推 `member_left`；群主已退 → `409 OWNER_LEFT`；非群主且未被 promote → `403 NO_PERMISSION`；响应 1–5s，或 `504 NETWORK_TIMEOUT`（**2 秒内收敛**） |
| `POST /groups/:groupId/leave { accountId }` | → `200` + 随后 `member_left`；或 `500`（没退成） |
| `GET /groups/:groupId/members` | → `[{ platformUserId }]`；**成员变更即刻生效，事件在其后推出** |

- `member_joined` / `member_left`：`{ groupId, platformUserId }`；**外部用户（非服务账号）进出群也推** → 需提供控制端点模拟"外部用户进出"（见 §3.5）。

### 3.3 发消息

| 端点 | 行为 |
|---|---|
| `POST /groups/:groupId/send { accountId, clientMsgId, text }` | → `202 { accepted: true }`（**可能延迟 1–2s 才返回**）；50–2000ms 后推 `message_sent { clientMsgId, msgId, sentAt }` 或 `message_failed { clientMsgId, code }` |
| `GET /groups/:groupId/messages/by-client-id/:clientMsgId` | → `200 { msgId, sentAt }` / `404`；同一 `clientMsgId` 落地多条时返回**最早一条** |

同步错误码：`429 RATE_LIMITED { retryAfterSeconds }`（等待期内任何 send 再得同样错误**且计时重置**）、`403 ACCOUNT_SUSPENDED`、`401 SESSION_EXPIRED`、`403 GROUP_WRITE_FORBIDDEN`、`403 SENDER_NOT_IN_GROUP`、`409 ACCOUNT_OFFLINE`、`504 NETWORK_TIMEOUT`、`503`（**任何端点，含 by-client-id**）。

**关键语义**：
- `sentAt` 毫秒精度，同毫秒可多条。
- **不按 `clientMsgId` 去重**：同 id 发两次 → 两条消息（幂等是后端的责任）。
- `504` 语义：若消息其实已被接收，网关**2 秒内落地并推 `message_sent`**；504 后 >2s 仍 `404` 即可确定未发出。
- `403 ACCOUNT_SUSPENDED` / `401 SESSION_EXPIRED` 后，该账号**所有请求**（含 connect）都返回同码；**可能不保证**再推 `account_status`。

### 3.4 事件流

- `GET /events?since=<eventId>`（SSE）。帧：`id: <eventId>` / `event: <type>` / `data: <JSON>`，`data` 内**同时带 `eventId` 与 `type`**。
- `type ∈ message | message_sent | message_failed | member_joined | member_left | account_status`。
- `eventId` 全局单调递增；`since` **独占**（返回 `eventId > since`）；**保留全部历史**。
- **at-least-once**：可重复推送；相邻事件可乱序（**窗口 ≤ 1s**）。
- `message` 事件：`{ groupId, msgId, senderPlatformUserId, text, sentAt, mediaUrl? }`；**包含服务账号自己发的**（`msgId` 与 `message_sent` 相同）。
- 连接随时可断；**事件流从服务启动即推送**，与是否 connect 无关。

### 3.5 控制端点（**模拟器私有，后端不依赖**）

前缀 `/_mock/`，用于驱动故障与外部行为；README 中标注"仅供测试"。后续 B4/前端测试也依赖它。

| 端点 | 用途 |
|---|---|
| `POST /_mock/accounts/:id/suspend` · `/session-expire` | 把账号推入终态；可开关"是否同时推 `account_status`"（题面说"可能不保证"） |
| `POST /_mock/accounts/:id/set-rate-limit { retryAfterSeconds }` | 预置限流 |
| `POST /_mock/groups/:id/external-join { platformUserId }` · `/external-leave` | 模拟外部用户进出群 → 推 `member_joined`/`member_left` |
| `POST /_mock/groups/:id/write-forbidden { on }` · `/dissolve` | 群不可写 / 解散 |
| `POST /_mock/messages/inject { groupId, senderPlatformUserId, text, sentAt? }` | 注入一条 `message` 事件（触发 agent 用） |
| `POST /_mock/events/replay { fromEventId, count }` | 重推历史事件（测 S2 重复 + 断流补拉） |
| `POST /_mock/events/duplicate-mode { on }` | 开启后**每个事件都推两次**（S2） |
| `POST /_mock/events/shuffle-mode { on, windowMs }` | 开启后按 ≤1s 窗口打乱相邻事件（乱序测试） |
| `POST /_mock/events/break-connection` | 断开所有 SSE 连接（断流测试） |
| `POST /_mock/faults { endpoint, mode, probability/persist }` | 通用故障注入：`503`、`504`、延迟、永久失败 |
| `POST /_mock/timing { profile: 'real' \| 'fast' }` | `fast` 把题面全部时序按比例压缩（e2e 用） |
| `POST /_mock/reset` | 清空全部状态（每个 e2e 场景开始前调用） |
| `GET /_mock/state` | 导出全量内部状态（断言用：成员、消息条数、是否收到某 `clientMsgId`） |

### 3.6 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3100 | |
| `TIMING_PROFILE` | `real` | `fast` 压缩时序 |
| `SEED_ACCOUNTS` | 由 docker-compose 传入 | `acct-1,acct-2,acct-3,acct-4`，初始 `idle` |
| `RATE_LIMIT_MODE` | `on` | 是否真的触发限流 |
| `JOIN_NEVER_ARRIVES_PROBABILITY` | `0` | 默认 0，避免随机性污染常规测试；需要时用端点开 |

---

## 4. 任务拆解

| # | 任务 | 产出 | 优先级 |
|---|---|---|---|
| 1.1 | 工程骨架 + Fastify + 内部 store（Account/Group/Message/Event） | 服务起得来 | P0 |
| 1.2 | 账号端点：connect / disconnect / 离线校验 | 幂等 platformUserId | P0 |
| 1.3 | 群与成员：create / invite / join / promote / kick / leave / members | 成员列表"先变后推事件" | P0 |
| 1.4 | 发消息：send 的 202 + message_sent/message_failed + by-client-id 查询 | 不去重语义 | P0 |
| 1.5 | SSE `/events`：since 独占、全局递增、保留全历史、断连清理 | `curl` 可观测 | P0 |
| 1.6 | 故障注入层：错误码中间件（429/403/401/503/504/延迟） | 统一在 store 层判定 | P0 |
| 1.7 | `/_mock/*` 控制端点全集 | §3.5 全部可用 | P0 |
| 1.8 | 乱序 / 重复 / 补投行为 | duplicate-mode、shuffle-mode、replay | P0 |
| 1.9 | timing profile（real/fast） | e2e 可跑 | P1 |
| 1.10 | 模拟器自测脚本（宿主机 python/bash 只调 HTTP） | 覆盖 S1–S5 的网关侧 | P1 |
| 1.11 | README 增补：网关模拟器说明 + 状态非持久化声明 | — | P1 |

---

## 5. 验收标准

- [ ] `docker compose up gateway-mock` 后，用 curl 走通：connect → create group → invite → join → send → 在 SSE 收到 `message_sent`。
- [ ] 同一 `accountId` 反复 connect，`platformUserId` 恒等。
- [ ] `disconnect` 后 `send` → `409 ACCOUNT_OFFLINE`。
- [ ] 同 `clientMsgId` 发两次 → `/_mock/state` 里 2 条消息；by-client-id 返回**最早一条**。
- [ ] `/_mock/faults` 打开某端点的 503 → 该端点（含 by-client-id）全部 503。
- [ ] `duplicate-mode` 开启后每个事件推两次；`shuffle-mode` 开启后相邻事件乱序但 `eventId` 仍单调。
- [ ] `/_mock/events/replay` 从 `fromEventId` 重推，带旧 `sentAt` 的消息也能补投出来。
- [ ] `break-connection` 后带 `since` 重连能补齐断流期间的全部事件。
- [ ] `suspend` 一个账号 → 它被移出所有群、推 `member_left`、之后所有请求返回 `403 ACCOUNT_SUSPENDED`。
- [ ] `external-join` 能推出 `member_joined`（非服务账号）。
- [ ] `fast` profile 下全部时序 < 500ms，e2e 可在秒级跑完。

---

## 6. 风险

| 风险 | 对策 |
|---|---|
| 模拟器行为不确定 → 后端 bug 难以定位 | `JOIN_NEVER_ARRIVES_PROBABILITY=0`、所有故障默认关闭，**必须显式打开**；`/_mock/reset` 保证场景可重跑 |
| 内存状态重启即失 | README 明确声明；补投语义靠 `/_mock/messages/inject` 重新构造，不依赖持久化 |
| 时序数字硬编码难调 | 全部走 `timing.ts` 单一来源，`fast` profile 只改比例 |
| 与后端耦合（后端偷看 `/_mock/`） | 后端只允许引用 §3.1–§3.4 的路径；`/_mock/*` 只出现在测试脚本里，代码 review 时检查 |
| 乱序实现破坏 `eventId` 单调 | 事件先入 store（`eventId` 已定），推送时只延迟/重排**发送时刻**，不改 `eventId` |

---

## 7. Commit 边界

一次 commit：

```
feat(gateway-mock): faithful message gateway simulator with fault injection

- accounts, groups, members, send, SSE /events with since replay
- exact timing (202 delay, 50-2000ms message_sent, 1-5s kick, 504 convergence)
- deterministic fault injection and /_mock control endpoints for S1-S8
```
