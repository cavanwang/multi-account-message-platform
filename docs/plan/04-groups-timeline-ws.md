# 切片 4：建群 / 时间线分页 / WebSocket 推送

> 上游依据：`docs/examination_project.md` §2.1、`docs/requirements.md` §5 A3 + A4、§6.2 B2 的建群部分
> 独立 commit：**是**。
> 前置：切片 0–3。

---

## 1. 目标与范围

1. **A3 建群**：异步 job（建群 → 申请邀请链接 → 各成员 join → 等 `member_joined` → promote `memberAccountIds[0]`）。
2. **A4 时间线**：游标分页，**并发写入下不重复、不遗漏**；实时追加。
3. **A4 WebSocket**：认证后推事件，`seq` 全局单调递增。
4. `GET /api/groups`、`GET /api/groups/:id`、`PATCH /api/groups/:id`、`GET /api/jobs/:jobId`、`GET /api/groups/:id/messages`。
5. 消费切片 3 写的 `web_events` 表 → 推 WS（**INV-5** 的落地）。

**不在本切片内**：`leave-all`（B2，切片 5）、Agent run 列表字段的实际内容（表建好，切片 5 填充）。

---

## 2. A3 建群

### 2.1 流程与异步 job

```
POST /api/groups { creatorAccountId, memberAccountIds[] }
  ├─ 同步校验：所有账号 online（否则 422 ACCOUNT_NOT_ONLINE）
  │             memberAccountIds ≥ 1 且不含群主（否则 400 VALIDATION_ERROR）
  └─ 事务内 INSERT jobs(status='running', steps=[]) → 202 { jobId }
        └─ worker 异步执行：
             1. create   网关建群 → groups 行（status='active'）
                          + 创建者写 group_members(role='creator')
                          【网关不为创建者推 member_joined】
             2. invite   申请链接 → { inviteLink, readyAfterMs }
                          INVITE_NOT_READY → 等 readyAfterMs 后**重试**
                          INVITE_EXPIRED → **重新申请链接后重试一次**
             3. join     对每个 memberAccountId 调 join（可并发，但结果按顺序记）
                          ALREADY_MEMBER → **视为成功**，直接进入 promote
                          member_joined 超时 10s 未到 → 该 step failed(JOIN_TIMEOUT)
             4. promote  把 memberAccountIds[0] 提升为 admin
                          NOT_MEMBER_YET → 重试，**promote 调用总数 ≤ 2**
                          member_joined 后写 group_members(role='admin')
             5. 其余成员在收到各自 member_joined 后写 group_members(role='member')
```

### 2.2 成员表写入时机（题目明确要求）

| 成员 | 写入时机 | role |
|---|---|---|
| 创建者 | **建群成功后**（不等事件） | `creator` |
| `memberAccountIds[0]` | **收到 `member_joined` 后** | `admin` |
| 其余 | **收到各自 `member_joined` 后** | `member` |

- 这一步由切片 3 的 `member_joined` handler 完成（它按 `platformUserId` 反查账号 → 若该账号属于某群 job 的待加入名单 → 写成员行）。
- **JOIN_TIMEOUT 规则**：`member_joined` 超过 **10 秒**未到 → job `failed`，`errors[].code = JOIN_TIMEOUT`。该超时由 job worker 的持久化定时器判定（不依赖内存）。

### 2.3 错误记录

`errors: [{ step, code }]`，`step ∈ create | invite | join:<accountId> | promote`。**`errors` 非空 → job `failed`**；成功 → `finished`。

### 2.4 新群默认

`agentEnabled = false`、`autoKickEnabled = false`、`status = 'active'`。

---

## 3. A4 时间线与 WS

### 3.1 游标分页（无重复、无遗漏）

```
GET /api/groups/:id/messages?before=<cursor>&limit=50   默认 50，上限 50
```

- 排序：`ORDER BY sent_at DESC, msg_id DESC`。
- **游标 = `(sentAt, msgId)` 的复合游标**，编码为不透明字符串 `base64url("<epochMillis>:<msgId>")`（对外不承诺格式）。
- 查询：
```sql
SELECT ... FROM messages
WHERE group_id = $gid
  AND (sent_at, msg_id) < ($cursorSentAt, $cursorMsgId)   -- ROW 比较，严格小于
ORDER BY sent_at DESC, msg_id DESC
LIMIT $limit + 1;                                          -- 多取一条判断是否还有更多
```
- **为什么用复合游标而非 `OFFSET` 或单列 `sentAt`**：`sentAt` 同毫秒可能多条（题目明确），单列游标会**丢消息**；`OFFSET` 在并发插入下会**重复**。`(sentAt, msgId)` 的 ROW 比较在"新消息插入"时仍然稳定（新消息的 `sentAt` 更大 → 落在第一页之前，不影响后续翻页）。
- `nextCursor`：有更多时为最后一条的游标，否则 `null`。
- item 字段：`{ msgId, clientMsgId, senderPlatformUserId, isOwn, text, sentAt, deliveryStatus, failCode }`；`deliveryStatus`/`failCode` 对**非自己的消息**为 `null`（题目：仅对自己的消息有意义）。
  - 自己的消息：`delivery_status` 取自 `outbox_messages`（通过 `client_msg_id` 关联）；若尚未有 `messages` 行（`queued`/`accepted` 阶段），**仍需出现在列表里**，`sentAt` 用受理时刻 → 因此列表查询要 `LEFT JOIN outbox_messages`，把"未落地但已受理"的行也 union 进来。
  - **一条消息只有一行**：`messages` 以 `(group_id, msg_id)` 唯一；outbox 行一旦有了 `gateway_msg_id` 就与 `messages` 行合并（不再单独出现）。

### 3.2 实时追加

- 新 `message` 事件落库后（切片 3）在**同一事务**写 `web_events`。
- 前端通过 WS 收 `message { groupId, msgId, isOwn }` → **按 `msgId` 去重后**插入列表。
- **不重复、不遗漏的边界**：前端翻页期间收到新消息 → 只追加到列表头，不改变已分页部分；若新消息恰好落在当前游标之前（补投的早消息）→ 前端在**下一次"加载更早"**时必然取到（因为游标基于 `(sentAt, msgId)`，补投的早消息 `sentAt` 更小 → 在更早的页里）。**这点写进 README 说明**，避免被当成 bug。

### 3.3 WebSocket

```
连接 → 收到 { type:'auth', accessToken, sinceSeq? }
      ├─ token 无效 → { type:'auth', success:false } → 关闭
      └─ 有效 → { type:'auth', success:true } → 开始推事件
帧格式：{ seq, type, payload }
```

- `seq` 来自 `web_events.seq`（`BIGSERIAL`），**全局单调递增**，天然与持久化顺序一致（INV-5）。
- **投递时机**：`web_events` 的行在业务事务内插入，事务提交后由**投递 worker**（轮询 `web_events` 的 `seq > last_pushed_seq`）推给所有已认证连接 → 保证"推给前端的状态事件对应已持久化的状态"。
- **`sinceSeq`（B4，可选但先做）**：认证时带 `sinceSeq` → 先补发 `seq > sinceSeq` 的历史事件，再进入实时推送。补发与实时之间用"先登记订阅、再补发`[sinceSeq, 当前最大 seq]`、再推实时"的顺序避免空窗/重复；前端按 `seq` 去重。
- **认证前不推任何事件**。
- 事件类型（切片 4 至少实现前 4 个）：
  - `account_status_changed { accountId, from, to }`
  - `account_terminal { accountId, status }`
  - `inconsistency { kind, ref, message }`
  - `message { groupId, msgId, isOwn }`
  - `agent_run { runId, groupId, status, endReason }`（切片 5）
  - `sequence_run { runId, groupId, status, currentStepIndex }`（切片 5）

---

## 4. 数据模型

```sql
-- 0004_groups_timeline_ws.sql
ALTER TABLE groups
  ADD COLUMN agent_enabled BOOLEAN NOT NULL DEFAULT false,       -- 切片 2 已建，若已存在则跳过
  ADD COLUMN auto_kick_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE jobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL CHECK (kind IN ('create_group','leave_all')),
  status     TEXT NOT NULL CHECK (status IN ('running','finished','failed')),
  errors     JSONB NOT NULL DEFAULT '[]'::jsonb,     -- [{ step, code }]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 建群 job 的待加入名单与 promote 计数（用于 JOIN_TIMEOUT 判定与 ≤2 次 promote）
CREATE TABLE group_job_members (
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts(id),
  joined_at   TIMESTAMPTZ,
  promote_calls SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, account_id)
);

-- WS 投递位点
CREATE TABLE ws_push_cursor (
  id             SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_pushed_seq BIGINT NOT NULL DEFAULT 0
);
```

`web_events` 已在切片 3 建立。

---

## 5. 任务拆解

| # | 任务 | 产出 | 优先级 |
|---|---|---|---|
| 4.1 | migration：`jobs` / `group_job_members` / `ws_push_cursor` | — | P0 |
| 4.2 | `POST /api/groups`：同步校验 + 入队 job + 202 | — | P0 |
| 4.3 | `workers/group-job.ts`：5 步流程 + INVITE_NOT_READY/EXPIRED/ALREADY_MEMBER 分支 | — | P0 |
| 4.4 | `JOIN_TIMEOUT`：持久化 10s 定时器 + job failed | — | P0 |
| 4.5 | promote 重试上限 ≤2 次 + `NOT_MEMBER_YET` 处理 | — | P0 |
| 4.6 | `member_joined` handler 扩展：回填成员行 + 完成 job 的 join 步骤 | 与切片 3 的 handler 对接 | P0 |
| 4.7 | `GET /api/jobs/:jobId` | — | P0 |
| 4.8 | `GET /api/groups` / `GET /api/groups/:id`（members + activeRunId 字段） | — | P0 |
| 4.9 | `PATCH /api/groups/:id`（agentEnabled / autoKickEnabled） | — | P0 |
| 4.10 | `GET /api/groups/:id/messages` 复合游标分页 + outbox LEFT JOIN | — | P0 |
| 4.11 | `GET /api/groups/:id/messages` 游标编解码 + 单测（含同毫秒多条） | — | P0 |
| 4.12 | WS 服务：`auth` 握手 + `sinceSeq` 补发 + 按 `seq` 推送 | — | P0 |
| 4.13 | `workers/ws-publisher.ts`：轮询 `web_events` → 推送 → 更新 `ws_push_cursor` | INV-5 | P0 |
| 4.14 | 单测：并发写入下翻页不重复不遗漏（同毫秒、翻页中断插新消息） | — | P0 |
| 4.15 | 单测：WS 认证失败不推事件；`seq` 单调；断线带 `sinceSeq` 补齐不重复 | — | P1 |
| 4.16 | 集成脚本：建群全流程 + JOIN_TIMEOUT 场景 | — | P1 |

---

## 6. 验收标准

- [ ] 建群全流程：3 个账号 → `jobId` → 轮询 `GET /api/jobs/:jobId` → `finished`；`GET /api/groups` 中 members 的 role 依次为 `creator`/`admin`/`member`。
- [ ] `memberAccountIds` 为空或无群主 → `400 VALIDATION_ERROR`；含离线账号 → `422 ACCOUNT_NOT_ONLINE`。
- [ ] 网关对 `member_joined` 永不推（模拟器开关）→ 10 秒后 job `failed`，`errors[].code = JOIN_TIMEOUT`。
- [ ] `INVITE_NOT_READY` → 不失败，等到 `readyAfterMs` 后成功；`INVITE_EXPIRED` → 重新申请后成功；`ALREADY_MEMBER` → 视为成功且 promote 照常。
- [ ] `promote` 调用总数 ≤ 2（模拟器记录调用次数断言）。
- [ ] **翻页无重复无遗漏**：插入 120 条同毫秒消息 → 逐页取完，总数 120、无重复 `msgId`；翻页中途插入新消息 → 已取页不受影响、剩余仍可取全。
- [ ] 自己的消息在 `queued` 阶段就出现在列表里且 `deliveryStatus = queued`；发出后同一行变为 `sent`（**不会出现两行**）。
- [ ] WS 连接未认证时不收到任何事件；认证后 `seq` 严格递增。
- [ ] 带 `sinceSeq` 重连 → 补发的历史事件与断线期间的新事件**合并后无重复**。
- [ ] `web_events` 中的状态事件推给前端时，对应 DB 状态**已提交**（人为在事务中途 kill → 前端不会收到未提交的转移）。

---

## 7. 风险

| 风险 | 对策 |
|---|---|
| 游标用单列 `sentAt` → 同毫秒丢消息 | 强制 `(sentAt, msgId)` ROW 比较；单测覆盖同毫秒 |
| 用 `OFFSET` → 并发插入重复 | 禁止 `OFFSET` 分页，代码 review 检查 |
| job 流程用内存状态 → 重启丢失 | job 每步的进度落库（`group_job_members` + `jobs.errors`）；超时判定走持久化定时器 |
| promote 重试超 2 次 | `promote_calls` 计数，硬上限；超限按 `NOT_MEMBER_YET` 记 error |
| WS 先推后写 → 违反 INV-5 | 推送只读 `web_events`（事务内插入），publisher 只按 `seq` 顺序推 |
| 补投的早消息"看不见" | README 说明：补投消息出现在更早的页里，需"加载更早"才可见；不视作遗漏 |

---

## 8. Commit 边界

建议两个 commit：

```
feat(groups): async group creation job with invite/promote retries

feat(timeline): cursor-paginated message timeline and WebSocket push
```
