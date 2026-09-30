# 切片 3：出站投递状态机 + 网关事件消费

> 上游依据：`docs/examination_project.md` §3.1、`docs/requirements.md` §5 A2 + §2 不变量
> 独立 commit：**是**。
> 前置：切片 0、1、2。
> 这是**整个项目最难、最关键的一块**（INV-1/2/4/5 都落在这里），也是 A5/B1 的共同底座。

---

## 1. 目标与范围

1. 出站消息的完整状态机：`queued → accepted → sent | failed | unknown | cancelled`，满足 **INV-1**（先落库再发）与 **INV-2**（不重复发）。
2. **504 的未知态收敛**：收到 504 起 **5 秒内**定态；重发**最多一次**且**必须在确认未发出之后**。
3. **429 限流**：账号进 `rate_limited`、等待期不向网关发该账号的 `send`、排队消息保持 `queued` 并按原顺序发出。
4. 网关**错误码 → 处理动作**的完整映射表。
5. **事件消费**：at-least-once、`(groupId,msgId)` 去重、≤1s 乱序容忍、任意早的补投、断流/停机后补齐（**INV-4**）。
6. 自身消息回流 → `isOwn = true`，**一条消息只有一行**，**不触发 agent**。
7. 事件处理自身 DB 写失败 → **不中断消费、不丢内容**，推 `inconsistency`。
8. 出站 API：`POST /api/groups/:id/send`。

**不在本切片内**：`GET /api/groups/:id/messages` 的分页查询（切片 4）、WS 投递（切片 4，本切片只负责把事件写进 `web_events` 表）、建群（切片 4）、Agent（切片 5）。

---

## 2. 核心设计

### 2.1 崩溃安全：Outbox 模式（INV-1 / INV-2）

> **先落库，再发网关；`clientMsgId` 由我们生成，在发之前就写进 DB。**

```
API/agent/sequence 请求
   └─ 事务内 INSERT outbox_messages(status='queued', client_msg_id=uuid)
        └─ 提交后返回 202 { clientMsgId }
             └─ send worker 轮询 queued 行 → 调网关 send
```

- 因为 `client_msg_id` 在请求前就持久化，**任何时刻崩溃 → 重启后 worker 能发现这条 `queued` 并继续**，不会"网关发了、库里没有"。
- **不重复发**：worker 用 `SELECT ... WHERE delivery_status='queued' ... FOR UPDATE SKIP LOCKED` 取行，并在**调网关前**先把状态推进到 `accepted`（乐观）——
  但 `accepted` 只表示"已提交给网关"，**不表示网关受理成功**。真正语义：
  - `queued → accepted` 发生在**网关返回 202 时**；
  - 若崩溃在"已发出 HTTP 但未收到 202"之间 → 重启后该行仍是 `queued`，会**再发一次** → 这正是 504/崩溃共用的问题，**用 `clientMsgId` + by-client-id 查询收敛**（§2.3）。
  - 因此引入 `generation` 列（见 §4）记录"已经向网关发出过几次 HTTP 请求"，`> 0` 的行在重发前必须先走 by-client-id 确认。

### 2.2 状态机

```
                    (网关 202)
queued ──────────────────────► accepted ──── (message_sent) ────► sent
   │                               │
   │                               └────── (message_failed) ────► failed
   │
   ├─ (504) ──► unknown ──┬─ (by-client-id 命中 / message_sent) ─► accepted → sent
   │                      └─ (确认未发出 → 重发一次) ─► accepted / failed(NETWORK_TIMEOUT)
   │
   └─ (终态后果 / 序列跳过 / 操作员取消) ──► cancelled
```

- `sent_at`：**自己的消息从 `queued` 起就在列表里**，初始用**受理时刻**（API 收到请求的时刻），收到 `message_sent` 后**改为网关的 `sentAt`**；一条消息**只有一行**。
- `failed` / `cancelled` 时 `failCode` 必填。

### 2.3 504 处理细则

```
收到网关 504
  ├─ delivery_status = 'unknown'        // 起算 5 秒窗口
  └─ 提交 t+2000ms 的收敛任务（DB 持久化，重启后重跑）
        ├─ GET /groups/:gid/messages/by-client-id/:cmid
        │     ├─ 200 { msgId, sentAt }  → accepted（随后 message_sent 会到）→ 最终 sent
        │     ├─ 404 且距收到 504 已 >2s → 确定没发出 → 允许重发一次
        │     │      ├─ 重发成功 → accepted → sent
        │     │      └─ 重发仍失败 → failed(failCode = NETWORK_TIMEOUT)
        │     └─ 503（查询端点也不可用）→ 保持 unknown，稍后重查
        └─ 硬约束：从收到 504 起 5 秒内必须变为 accepted/sent/failed 之一
              （by-client-id 不可用期间保持 unknown，恢复后 2 秒内定态）
```

- **确认没有发出之前不能重发**（`404` 且已过 2 秒才算确认）。
- **重发总共只允许一次**：`resend_count` 列，`resend_count >= 1` 时不再重发，直接 `failed(NETWORK_TIMEOUT)`。
- 重发复用**同一个 `clientMsgId`**（网关不去重，但我们只发一次就够了；若第一次其实已落地，by-client-id 会先告诉我们，从而不会重发）。

### 2.4 错误处理表（网关返回 → 动作）

| 网关返回 | 动作 | 涉及状态 |
|---|---|---|
| `429 RATE_LIMITED {retryAfterSeconds}` | 账号 → `rate_limited`（CAS，`rate_limited_until = now+N`）；等待期内**不再向网关发该账号的 send**（`disconnect`/`leave` 不受限）；该账号 `queued` 消息**保持 queued**，到期后**按原顺序**发出；**序列步骤顺延不跳过** | account + outbox + sequence_steps |
| `403 ACCOUNT_SUSPENDED` | 账号 → `suspended`，走 **终态事务**（切片 2 §5） | account |
| `401 SESSION_EXPIRED` | 账号 → `session_expired`，走 **终态事务** | account |
| `403 GROUP_WRITE_FORBIDDEN` | 群 → `unreachable`；该群序列运行 → `stopped`；agent 不再触发；运行中的 agent run 在**当前步后** `cancelled`；**账号状态不变** | group + sequence + agent |
| `403 SENDER_NOT_IN_GROUP` | **该条** `failed(failCode=SENDER_NOT_IN_GROUP)`；账号、群**状态不变** | outbox |
| `409 ACCOUNT_OFFLINE` | 同上，`failCode=ACCOUNT_OFFLINE` | outbox |
| `504 NETWORK_TIMEOUT` | 见 §2.3 | outbox |
| `503` | 端点整体不可用 → 退避重试，**不改状态**；by-client-id 也可能 503 | — |
| `message_failed { code }` 事件 | 该条 `failed(failCode=code)`；若 `code=ACCOUNT_SUSPENDED` → 账号终态 | outbox + account |

**限流的两个细节（容易漏）**：
1. 等待期内任何 `send` 都再得同样错误**且计时重置** → 所以等待期内**根本不发**，避免雪崩式重置。
2. 到期恢复是切片 2 的 sweep worker，恢复后 outbox worker 自然继续按 `created_at` 顺序发。

### 2.5 事件消费（INV-4 / INV-5）

**用 inbox 表先落原始事件，再处理**——这是"不中断、不丢内容、可重放、可去重"的统一解法：

```
SSE 收到帧
  └─ 事务：INSERT INTO events_inbox(event_id, type, payload) ON CONFLICT (event_id) DO NOTHING
       └─ 更新 events_cursor.last_seen_event_id = max(...)
  （consumer worker 独立轮询 events_inbox WHERE processed_at IS NULL ORDER BY event_id）
       └─ 逐条在事务内处理；成功 → processed_at=now()
            └─ 处理抛错 → 记录 last_error，**不写 processed_at**，推 inconsistency，继续下一条
```

- **为什么不直接处理 SSE 帧**：SSE 帧在内存里，崩溃即丢（违反 INV-4）；inbox 落库后，"处理"变成可重放的 DB 操作。
- **去重**：`events_inbox.event_id` 主键 → 同一事件重复推送只入一行（**S2** 网关推两次也只会被消费一次）。
- **乱序 ≤1s**：不按 `event_id` 顺序依赖业务语义；`message` 事件按 `(groupId, msgId)` upsert，**`sentAt` 乱序不影响最终结果**（展示按 `sentAt` 排序）。消费顺序按 `event_id` 升序、但**不要求** `sentAt` 单调。
- **断流/停机补齐**：`events_cursor.last_seen_event_id` 持久化；重连带 `since=last_seen_event_id`（**独占**语义正好衔接）。停止期间的事件在恢复后被补拉入 inbox 并被处理 → **INV-4**。
- **补投（任意早的 `sentAt`）**：不做任何"太旧就丢弃"的判断；`(groupId, msgId)` 未见过就插入，见过的就 upsert。
- **DB 写失败不中断**：如上，失败的行保留 `last_error` 且不置 `processed_at`，重试由 worker 下轮拾取；同时入队 `inconsistency { kind, ref, message }` 到 `web_events` → 操作员可见。
- **INV-5**：所有 `web_events` 的插入都在**业务事务内部**完成，提交后才投递 WS（切片 4）。

### 2.6 自身消息回流（S3）

网关把服务账号自己发出的消息也作为 `message` 事件推回（`msgId` 与 `message_sent` 相同）。处理：

```
收到 message 事件
  ├─ 用 senderPlatformUserId 反查 group_members → 命中服务账号 → isOwn = true
  ├─ upsert 到 messages(group_id, msg_id) 唯一键
  │     ├─ 已存在（由 message_sent 先行写入） → 只更新 text/sentAt/mediaUrl
  │     └─ 不存在 → 插入（sender 可能是外部用户，isOwn=false）
  └─ isOwn = true → **不触发 agent**（连"待处理列表"都不入）
```

- **一条消息只有一行**：`messages` 表以 `(group_id, gateway_msg_id)` 唯一；`message_sent` 与回流的 `message` 写的是同一行。
- 出站行（`outbox_messages`）与展示行（`messages`）通过 `gateway_msg_id` 关联：`message_sent` 到达时 upsert `messages` 并回填 `outbox_messages.gateway_msg_id`。

---

## 3. 对外契约

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST /api/groups/:id/send` | `{ accountId, text }` | `202 { clientMsgId }` | `409 ACCOUNT_NOT_IN_GROUP` / `409 ACCOUNT_UNAVAILABLE` / `400 VALIDATION_ERROR` |

- 账号 `idle`/`disconnected`/终态 → `409 ACCOUNT_UNAVAILABLE`。
- 账号**不在该群** → `409 ACCOUNT_NOT_IN_GROUP`。
- 账号 `rate_limited` → **照常受理**，记录保持 `queued`，到期后按顺序发出（**不算失败**）。

---

## 4. 数据模型（新增/扩展）

```sql
-- 0003_outbound_and_events.sql
CREATE TABLE messages (
  msg_id                  TEXT NOT NULL,                 -- 网关 msgId
  group_id                UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  client_msg_id           UUID,                          -- 自己发的才有
  sender_platform_user_id TEXT NOT NULL,
  is_own                  BOOLEAN NOT NULL DEFAULT false,
  text                    TEXT NOT NULL,
  sent_at                 TIMESTAMPTZ NOT NULL,
  media_url               TEXT,
  local_file_path         TEXT,                          -- C1 用，先留位
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, msg_id)
);
-- 时间线游标分页：按 sentAt 倒序、msgId 破平（切片 4 使用）
CREATE INDEX messages_timeline_idx ON messages (group_id, sent_at DESC, msg_id DESC);

CREATE TABLE events_inbox (
  event_id     BIGINT PRIMARY KEY,                       -- 网关 eventId，去重键
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX events_inbox_pending_idx ON events_inbox (event_id) WHERE processed_at IS NULL;

CREATE TABLE events_cursor (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seen_event_id  BIGINT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 504 收敛任务（持久化定时器，崩溃安全）
CREATE TABLE pending_reconciliations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id      UUID NOT NULL REFERENCES outbox_messages(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('resolve_504','retry_offline')),
  due_at         TIMESTAMPTZ NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pending_recon_due_idx ON pending_reconciliations (due_at);

-- 切片 4 定义 web_events；本切片先建（事务内入队、提交后投递）
CREATE TABLE web_events (
  seq        BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`outbox_messages` 增列（新 migration，不改旧列语义）：

```sql
ALTER TABLE outbox_messages
  ADD COLUMN generation SMALLINT NOT NULL DEFAULT 0;   -- 已向网关发出的 HTTP 次数
```

---

## 5. 任务拆解

| # | 任务 | 产出 | 优先级 |
|---|---|---|---|
| 3.1 | migration：`messages` / `events_inbox` / `events_cursor` / `pending_reconciliations` / `web_events` + outbox `generation` | — | P0 |
| 3.2 | `repos/outbox.ts`：入队、`FOR UPDATE SKIP LOCKED` 取待发、CAS 改状态 | — | P0 |
| 3.3 | `POST /api/groups/:id/send`：事务入队 `queued` → 202 | INV-1 | P0 |
| 3.4 | `workers/outbox-sender.ts`：按 `created_at` 顺序发，处理 202/同步错误码 | §2.4 | P0 |
| 3.5 | `services/delivery.ts`：状态机迁移的**唯一入口**（所有状态改动走它） | — | P0 |
| 3.6 | 504 → `unknown` + `pending_reconciliations` 收敛 worker（5s 硬约束 + 一次重发） | §2.3 | P0 |
| 3.7 | 429 处理：账号限流 + outbox 保持 queued + 到期续发 | §2.4 | P0 |
| 3.8 | `workers/event-consumer.ts`：SSE 客户端 + inbox 落库 + 幂等消费 | INV-4 | P0 |
| 3.9 | `services/event-handlers/*.ts`：`message` / `message_sent` / `message_failed` / `member_*` / `account_status` 各一个 handler | 每个 handler 独立可测 | P0 |
| 3.10 | `inconsistency` 入队（消费失败、disconnect 失败、DB 写失败） | INV-4 的可见性 | P0 |
| 3.11 | 单测：504 全路径（含 by-client-id 503 期间保持 unknown）、重发仅一次 | — | P0 |
| 3.12 | 单测：事件重复（S2）、乱序（人为打乱）、补投（早 `sentAt`） | — | P0 |
| 3.13 | 单测：自身消息回流（S3）不产生第二行、不触发 agent | — | P0 |
| 3.14 | 集成脚本：停机 5 秒 → 恢复 → 事件全被处理（INV-4） | 宿主机脚本只调 HTTP | P1 |

---

## 6. 验收标准

- [ ] **S1**：网关先回 202、后推 `message_sent` → `message_sent` 前 `deliveryStatus = accepted`，之后为 `sent`。
- [ ] **S2**：网关把每个事件推两次 → 时间线无重复行；agent 不被重复触发。
- [ ] **S3**：自己的消息回流 → `isOwn = true`；**不产生新的 agent run**。
- [ ] **S4**：`429` → 账号进 `rate_limited`；到期前 `/_mock/state` 显示网关**收不到**该账号的 send；到期自动恢复。
- [ ] **S5（前半）**：网关对 send 回 504、1.5 秒后消息落地 → 从收到 504 起 **5 秒内**变为 `sent`（不是 `failed`）。
- [ ] 504 且网关确实未接收 → 2 秒后确认 → **重发一次** → 网关里**恰好一条**消息。
- [ ] 504 后 by-client-id 返回 503 → 保持 `unknown`；恢复后 **2 秒内**定态。
- [ ] 强行让重发失败 → `failed(failCode = NETWORK_TIMEOUT)`，且**不再有第三次**发送。
- [ ] 崩溃测试：在"HTTP 已发出、202 未返回"处 kill 进程 → 重启后不产生第二条消息。
- [ ] 事件 handler 内人为抛错 → 消费**不中断**（后续事件仍处理），推 `inconsistency`，该事件**不丢**（`last_error` 留存，下轮重试）。
- [ ] 停机 5 秒期间注入 10 条事件 → 恢复后全部处理，时间线 10 条、无重复。
- [ ] 乱序注入（后到的事件 `sentAt` 更早）→ 时间线仍按 `sentAt` 正确排序。
- [ ] `GROUP_WRITE_FORBIDDEN` → 群 `unreachable`、群序列 `stopped`、**账号状态不变**。
- [ ] `ACCOUNT_OFFLINE` / `SENDER_NOT_IN_GROUP` → 该条 `failed`、账号与群状态不变。
- [ ] `POST /api/groups/:id/send` 对 `rate_limited` 账号 → `202`，行保持 `queued`，到期后发出。

---

## 7. 风险

| 风险 | 对策 |
|---|---|
| **INV-1/INV-2**：先发后写或重复发 | outbox 先落库 + `client_msg_id` 唯一 + `generation` 计数；重发前必须 by-client-id 确认 |
| **504 收敛**：5 秒硬约束、只许一次重发 | `pending_reconciliations` 落库定时器；`resend_count` 硬上限；by-client-id 503 时显式保持 `unknown` |
| **事件丢**：SSE 帧在内存里 | inbox 表先落库，处理与接收解耦；`events_cursor` 持久化 `since` |
| **乱序**：≤1s 窗口 + 任意早补投 | 去重键 `(groupId,msgId)` 而非 `eventId` 顺序；不假设 `sentAt` 单调 |
| **重复触发 agent** | `(groupId,msgId)` 唯一 + S2 开关下验证；`isOwn` 不进待处理 |
| **`web_events` 先于持久化** | 所有 `web_events` 插入在业务事务内，提交后投递 |
| **无限重试打爆网关** | `pending_reconciliations.attempts` 上限 + 指数退避；503 期间只退避不改状态 |

---

## 8. Commit 边界

建议**拆成两个 commit**（各自可独立验证，避免一个大 commit）：

```
feat(outbound): crash-safe outbound delivery with 504/429 convergence

feat(events): at-least-once gateway event consumer with dedup and inbox replay
```

- 第一个 commit：3.1–3.7 + 3.11（出站能发出去、能收敛）。
- 第二个 commit：3.8–3.10 + 3.12–3.13（事件进来、去重、回流、不丢）。
