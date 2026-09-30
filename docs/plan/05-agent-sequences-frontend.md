# 切片 5：Agent 接入 / 定时序列 / 前端 / 交付收尾

> 上游依据：`docs/examination_project.md` §2.2、§3–§5、`docs/requirements.md` A5 / B1–B4 / §7 / §8 / §9
> 独立 commit：**按子块各一次**（见 §8）。
> 前置：切片 0–4。Agent 模拟器需先于 A5 实现。

---

## 第一部分：Agent 模拟器（A5 的前置）

### 1.1 职责

独立容器 `agent-mock`，忠实实现 `docs/requirements.md` §3.2：`POST /agent/turn`、`POST /agent/audit`，**能按需复现全部坏行为**。默认走"正常"脚本，坏行为通过 `/_mock/` 显式开启。

### 1.2 契约要点

- `POST /agent/turn { runId, tools, messages }` → 恰好一个块的响应。
  - `tools` **必须恰好 4 个**，`input_schema` 合法 JSON Schema 且 `required` 覆盖全部入参 → 否则 `400 TOOLS_INVALID`。
  - `200 { stop_reason:'tool_use', content:[{ type:'tool_use', id, name, input }] }`
  - `200 { stop_reason:'end_turn', content:[{ type:'text', text }] }`
  - **每轮恰好一个块**；`tool_result.is_error` 可省略（视为 false）。
- `POST /agent/audit { text, groupId }` → `200 { verdict: 'pass'|'fail', reason }`。
- 按 `runId` 维护会话状态（**同一 run 的所有请求必须用同一 runId**）。
- 触发上下文 `messages[0]` 的 text 为 JSON 串：`{ groupId, triggerMessages[], policy:{autoKickEnabled}, ownPlatformUserIds[] }`，`triggerMessages` 按 `sentAt` 升序。

### 1.3 四个工具（名字/入参固定）

| 工具 | 入参 | 成功 content | 备注 |
|---|---|---|---|
| `get_recent_messages` | `{ limit }` | `{ messages:[{msgId,senderPlatformUserId,isOwn,text,sentAt}], truncated }` | 升序；含触发消息与 run 期间新到的；`limit` 上限 50；单条 text > 500 字截断并 `truncated:true` |
| `send_message` | `{ text, idempotency_key }` | `{ clientMsgId, deliveryStatus }` | 变为 `accepted`/`sent` 后返回（最多 5s）；`failed` 时按码返回错误 |
| `kick_user` | `{ platform_user_id, reason }` | `{ kicked: true }` | |
| `finish` | `{ summary }` | `{ ok: true }` | 收到后不再调 `/agent/turn` |

**错误 tool_result**：`is_error:true`，content 为 `{ code, message, hint? }`。12 个码：`UNKNOWN_TOOL` / `INVALID_INPUT` / `DUPLICATE_TOOL_USE_ID` / `BAD_JSON` / `TURN_TIMEOUT` / `AUDIT_REJECTED` / `POLICY_DENIED` / `SEND_TIMEOUT` / `SEND_FAILED` / `NO_AVAILABLE_ACCOUNT` / `GROUP_UNREACHABLE` / `OWNER_LEFT` / `NO_PERMISSION`。

**`send_message` 失败码映射**：群不可写 → `GROUP_UNREACHABLE`；账号停用/失效/中途变终态 → `SEND_FAILED`；5 秒仍无法确认 → `SEND_TIMEOUT`。

### 1.4 必须能复现的坏行为（`/_mock/` 开关）

| 行为 | 开关 |
|---|---|
| 响应体非合法 JSON / 套 markdown 围栏 / 前后夹文字 | `/_mock/behavior { mode:'bad_json' }` |
| 调用 `tools` 之外的工具；入参不合 schema | `{ mode:'unknown_tool' }` / `{ mode:'invalid_input' }` |
| 同一 `tool_use.id` 用两次 | `{ mode:'duplicate_id' }` |
| 拿到 `send_message` 结果后用同一 `idempotency_key` 再调一次（尤其 `SEND_TIMEOUT` 后） | `{ mode:'retry_same_key' }` |
| 一直调工具不结束；连续同样入参调 `get_recent_messages` | `{ mode:'never_finish' }` / `{ mode:'repeat_get' }` |
| 调 `get_recent_messages { limit: 100000 }` | 内建 |
| 响应很慢（≥8s）或不返回 | `{ mode:'slow', delayMs }` / `{ mode:'hang' }` |
| audit 返回 500 / 非法 JSON / 无 verdict / verdict 非法 / 慢 / 不返回 | `/_mock/audit { mode:... }` |

---

## 第二部分：A5 Agent 接入（难度最高）

### 2.1 触发与互斥（INV-7）

- `agentEnabled=true` 的群出现**非自己的**消息 → 创建一次 agent run。
- **同一群同一时刻至多一个 `running` 的 run，多实例部署下也成立**：靠**唯一索引**，不用进程内状态。
  ```sql
  CREATE UNIQUE INDEX agent_runs_one_running
    ON agent_runs (group_id) WHERE status = 'running';
  ```
  插入 `running` 行失败（唯一冲突）→ 说明已有 run 在跑 → 把消息记为**待处理**。
- run 进行期间到达的非自己消息 → 写 `agent_run_pending_messages`。
- run 结束时若有待处理消息 → **立即创建下一次 run**，把这些消息**全部**放进 `triggerMessages`（**一次 run，不是逐条触发**）。

### 2.2 循环与上限

一步 = 一次 `/agent/turn` 往返（无论返回什么）；**审计重试不算步**。

| 上限 | 规则 | endReason |
|---|---|---|
| **12 步**（含结束那一步） | 超出 | `budget_exhausted` → `failed` |
| **60 秒**（从 run 创建起，含等审计；**重启后从恢复时刻继续累计，停机时间不计**） | 超出 | `wall_clock` → `failed` |
| **连续 3 次协议错误**（任何一次合法响应清零） | 达到 | `protocol_errors` → `failed` |

- `/agent/turn` 每轮超时 **10–15 秒（可配）** → 超时记一次协议错误（`TURN_TIMEOUT`），**超时后才到的响应丢弃**（用请求代际号丢弃迟到响应）。
- **60 秒的停机时间不计**：run 行记 `accumulated_ms` 与 `last_tick_at`；恢复时 `last_tick_at` 之后的时间才计入。

### 2.3 两类协议错误（处理方式不同，最易错）

| 情形 | 处理 |
|---|---|
| **未知工具 / 入参不合 schema** | **正常追加** assistant 的 `tool_use` 块 → 再追加 `is_error:true` 的 `tool_result`（`UNKNOWN_TOOL` / `INVALID_INPUT`） |
| **坏响应（`BAD_JSON`）/ 重复 `tool_use.id` / 超时** | **不追加 assistant 块**，改为追加一条 `role:'user'` 的 text 块 `PROTOCOL_ERROR <code>: <一句话>`；**计入步数**，`steps[]` 记 `kind='protocol_error'`，`rawResponse` = 原始响应体 |

**`BAD_JSON` 三种情形**：① 非 2xx；② 响应体不是合法 JSON（含围栏/夹文字）；③ JSON 合法但形状不符（缺 `stop_reason`、块数 ≠ 1、`stop_reason` 与块类型不一致）。

### 2.4 审计

- `send_message` / `kick_user` 执行前必须过 `/agent/audit`。
  - `send_message`：`text` = 待发文本。
  - `kick_user`：`text` = `JSON.stringify({ action:'kick', platform_user_id, reason })`。
- 只有**合法 JSON 且 `verdict === 'pass'`** 才执行；`fail` → 返回 `AUDIT_REJECTED`（不执行）。
- 拿不到明确结论（含超时）→ **同一次工具调用最多 3 次**（耗时计入 60s；**单次失败不返回给 agent、不计步**）；3 次都失败 → run `blocked`、`endReason = audit_blocked`、**该工具不执行**、推事件通知操作员。

### 2.5 执行账号选择

- 只能用**该群里 `online` 的服务账号**；`kick_user` 还需 `role ∈ {creator, admin}`。
- 没有可用账号 → `NO_AVAILABLE_ACCOUNT`（**不算协议错误，计入步数**）。
- 账号**执行中途变终态** → 该步 `SEND_FAILED`，**run 继续**。

### 2.6 `kick_user` 与策略

群 `autoKickEnabled = true` 才允许，否则 `POLICY_DENIED`。

### 2.7 幂等（S5）

- 同一 run 内相同 `idempotency_key` 的 `send_message`：**第二次及以后不再发送、不再审计**，返回那条消息的**当前状态**。
- 被 `AUDIT_REJECTED` / `POLICY_DENIED` 拒绝的调用**不算用过这个 key**。
- 实现：`agent_tool_calls(run_id, idempotency_key)` 唯一；已存在 → 直接查 `outbox_messages` 返回当前状态，**跳过审计**。

### 2.8 恢复（INV-3，最关键）

- 服务在 run 进行中任意时刻重启 → run **用同一 `runId`** 从中断处继续并正常结束。
- **已产生对外效果的工具调用不能再执行一次，也不能被记成失败**：
  - 每步在**执行前**先把 `agent_steps(status='pending_execution', tool_use_id, input)` 落库；
  - 对外效果（`send_message` / `kick_user`）用**幂等键 + `tool_use_id`** 去重；
  - 恢复时若发现有 `pending_execution` 步，**先判定对外效果是否已发生**（查 `outbox_messages` / 网关成员列表）再决定继续/回填，**绝不重放已生效的调用**（对齐 INV-3 与 S5）。
- 恢复时**重建 `messages` 数组**：从 `agent_run_messages` 表按序读回（assistant / user 块都持久化）。

### 2.9 结果大小与外部状态变化

- 单个 `tool_result.content` ≤ **8KB**，超出截断并置 `truncated:true`；`resultSummary` ≤ 200 字；`rawResponse` 截断到 **2KB**。
- 群变 `unreachable`、或 `agentEnabled` 被关闭 → 正在运行的 run **在当前步结束后终止**，`endReason = cancelled` → `status = cancelled`。
- 重复调用 `get_recent_messages`（同样入参）：策略由我们决定 → **连续第 2 次相同入参时返回一次提示性 `INVALID_INPUT`（提示"重复调用，请基于已有信息决策"）**，保证 run 在 12 步内合理结束。

### 2.10 结束

- 收到 `finish` → run `finished`，`endReason = final`，`input.summary` 存为 `summary`。
- 收到 `stop_reason:'end_turn'` → 同样结束，`text` 存为 `summary`，**不发到群里**。

---

## 第三部分：B1 定时序列

### 3.1 序列与启动

```
POST /api/sequences（序列 JSON） → { id }
POST /api/groups/:id/sequence-runs { sequenceId, vars, stepVars }
    → 201 { runId } | 409 SEQUENCE_ALREADY_RUNNING | 422 UNRESOLVED_PLACEHOLDER(带 stepIndex, key)
```

### 3.2 账号选择

- `accountRole = admin` → 群里 `role ∈ {creator, admin}` 且 `online` 的账号，**优先 `admin`**。
- `accountRole = member` → `role = member` 且 `online` 的账号中按 `accountId` **字典序取第一个**。
- 没有匹配账号 → 该步 `skipped`。
- **`rate_limited` 的账号不算"没有"** → 该步**顺延**到限流结束后发出（不是 skipped）。

### 3.3 占位符与变量

- 文本里 `{key}` 在**发送时**解析；key 匹配 `[A-Za-z0-9_]+`。
- 取值规则：
  - 开始时 = `vars`；某步在 `stepVars` 给了值 → **从这一步起（含）后续步骤都用新值**，直到更晚的步骤再次给值（**黏性**）。
  - `stepVars` 里的 `""` → **这一步不改**。
  - `vars` 里的 `""` → **视为未提供**。
- **预检（S8）**：启动前检查所有步骤，任何 `{key}` 解析不到 → `422 UNRESOLVED_PLACEHOLDER`，带 `stepIndex`、`key`，**一条都不发，也不留下运行中的记录**（之后可正常启动）。
- `resolvedVars` 为**最终取值**；`varSources` 标每个 key 来自 `default`（`vars`）还是 `step:<index>`——**沿用前面某步的值时，标最初给出它的那一步**。

### 3.4 互斥与排期

- 同一群同一时刻至多一个 `running`（DB 唯一索引，同 §2.1）；并发两次启动 → **恰好一个 201、一个 409**（S7）。
- "发出" = 收到 `message_sent` 的时刻。
- 第 1 步在启动后 `delaySeconds` 秒发送；第 n 步在第 n-1 步**发出后** `delaySeconds` 秒发送；**跳过的步骤视为在跳过时刻"发出"**。
- `skipped` 步骤**有时间戳**，进度照常推进。
- **重启后（最易错）**：只重排**最早一个已过期的步骤**（`重启时刻 + 该步 delaySeconds`），后续步骤仍按"前一步发出后"排期，**不能一次性全部发出**。

### 3.5 状态

run：`running | finished | failed | stopped`（`stopped` = 群变 `unreachable`）。
step：`pending | accepted | sent | skipped | failed`。

---

## 第四部分：B2 / B3 / B4

### 4.1 B2 `leave-all`

```
POST /api/groups/:id/leave-all → 202 { jobId }
```
- 所有服务账号退群，**群主最后退**（群主先退则其余账号无法操作）。
- 非群主账号退群失败 → 记入 `errors[]`，**其余非群主继续退，群主不退**，job `failed`；失败账号在我们 DB 和网关里**都仍是成员**。
- 全部成功 → 群 `status='left'`、`members = []`；完成后我们 DB 的成员表与网关成员列表**一致**。

### 4.2 B3 登录会话（refresh 轮换 + 复用检测）

- refresh token **只通过 HttpOnly cookie 下发，不放响应体**；`POST /api/auth/refresh`（读 cookie）→ `{ accessToken }` + **新的 `Set-Cookie`**。
- **每次使用后轮换**；**旧的再被使用 → `401`，整个会话作废**：之前换出的新 refresh token 和新 access token **都立即失效**。
  - 实现：`sessions(id, user_id, current_refresh_hash, revoked_at)` + `refresh_tokens(hash, session_id, used_at, replaced_by)`；检测到"已 `used_at` 的 token 被再次使用" → 把整个 session 置 `revoked_at`。
  - **access token 立即失效**：JWT 无状态，需查表 → 每个 access token 带 `sid`，中间件校验 `sessions.revoked_at IS NULL`。
- `POST /api/auth/logout` 后，**同一个 access token 立即失效**（置 `revoked_at`）。
- **前端**：access token 过期自动续期；多个请求同时 401 → **只发一次 refresh**（单飞）。

### 4.3 B4 断线补齐

- 前端断线期间的事件，重连后 **3 秒内**出现在页面，且**不重复**（WS `sinceSeq` + 前端按 `seq` 去重）。
- Agent 运行详情页可查看每一步（含协议错误步的原始响应体）。

---

## 第五部分：前端（§7 五页）

React 18 + TS + Vite。不需要 i18n / 主题切换 / 响应式。

| # | 页面 | 要点 |
|---|---|---|
| 1 | **登录** | `viewer` 登录后看不到写操作按钮 |
| 2 | **账号列表** | 显示状态；「标记离线」「重连」「释放账号」三个按钮**只在对应转移合法时出现**（读转移表）；`viewer` 看不到按钮，**直接调接口也得到 403** |
| 3 | **群详情** | 成员列表（含 role）；消息时间线（「加载更早」；实时追加；自己的消息显示 `deliveryStatus`）；最近 agent run 列表（状态、endReason），**`blocked` 的 run 醒目提示** |
| 4 | **Agent 运行详情** | 每步 `kind`、工具名、入参、结果摘要、审计结论、错误码；**协议错误步可查看原始响应体** |
| 5 | **序列运行** | 选序列、填 `vars`/`stepVars` → **预检弹窗**（每步每个 key 的最终取值与来源）→ 启动；运行中显示进度；预检不通过显示 `stepIndex` 与 `key` |

**前端配套**：API client（401 单飞 refresh）、WS client（`sinceSeq` 补发 + `seq` 去重）、权限 hook（`viewer` 隐藏写操作）。

---

## 第六部分：接口与数据模型

| 端点 | 说明 |
|---|---|
| `GET /api/agent-runs/:id` | `{ id, groupId, status, endReason, summary, steps:[{ kind, toolUseId, name, input, resultSummary, isError, errorCode, auditVerdict, rawResponse }] }` |
| `GET /api/groups/:id/agent-runs` | 最近运行列表（可不含 steps） |
| `POST /api/sequences` · `POST /api/groups/:id/sequence-runs` · `GET /api/sequence-runs/:id` | 见 §3 |

```sql
-- 0005_agent_and_sequences.sql
CREATE TABLE agent_runs (
  id            UUID PRIMARY KEY,
  group_id      UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('running','finished','failed','blocked','cancelled')),
  end_reason    TEXT,               -- final|budget_exhausted|wall_clock|protocol_errors|audit_blocked|cancelled
  summary       TEXT,
  accumulated_ms INT NOT NULL DEFAULT 0,
  last_tick_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_runs_one_running ON agent_runs (group_id) WHERE status = 'running';

CREATE TABLE agent_run_messages (   -- 恢复时重建 messages 数组
  id         BIGSERIAL PRIMARY KEY,
  run_id     UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  blocks     JSONB NOT NULL
);

CREATE TABLE agent_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_no       INT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('tool_use','final','protocol_error')),
  tool_use_id   TEXT,               -- protocol_error 时为 NULL
  name          TEXT,
  input         JSONB,
  result_summary TEXT,
  is_error      BOOLEAN NOT NULL DEFAULT false,
  error_code    TEXT,
  audit_verdict TEXT,
  raw_response  TEXT,               -- 截断 2KB
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_no)
);

CREATE TABLE agent_tool_calls (     -- 幂等：同 run 同 key 只执行一次
  run_id          UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  outbox_id       UUID REFERENCES outbox_messages(id),
  tool_use_id     TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending_execution','executed')),
  PRIMARY KEY (run_id, idempotency_key)
);

CREATE TABLE agent_run_pending_messages (
  run_id  UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  msg_id  TEXT NOT NULL,
  PRIMARY KEY (run_id, msg_id)
);

CREATE TABLE sequences (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  steps      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sequence_runs
  ADD COLUMN sequence_id UUID REFERENCES sequences(id),
  ADD COLUMN vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN step_vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN current_step_index INT NOT NULL DEFAULT 0;

ALTER TABLE sequence_steps
  ADD COLUMN scheduled_at TIMESTAMPTZ,
  ADD COLUMN sent_at TIMESTAMPTZ,
  ADD COLUMN client_msg_id UUID,
  ADD COLUMN resolved_vars JSONB,
  ADD COLUMN var_sources JSONB;

CREATE TABLE sessions (          -- B3
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_refresh_hash TEXT,
  revoked_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  hash       TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  used_at    TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);
```

---

## 第七部分：任务拆解

| # | 任务 | 优先级 |
|---|---|---|
| 5.1 | Agent 模拟器：`/agent/turn` + `/agent/audit` 正常路径 + 4 工具校验 | P0 |
| 5.2 | Agent 模拟器：§1.4 全部坏行为 `/_mock/` 开关 | P0 |
| 5.3 | migration：`agent_*` / `sequences` / `sequence_*` / `sessions` / `refresh_tokens` | P0 |
| 5.4 | A5.1 触发 + 待处理队列 + run 结束立即再触发 | P0 |
| 5.5 | A5.2 循环 + 12 步/60 秒/连续 3 次协议错误 + turn 超时与迟到响应丢弃 | P0 |
| 5.6 | A5.3 两类协议错误的不同追加方式 | P0 |
| 5.7 | A5.4 审计 + 3 次重试 + `blocked` | P0 |
| 5.8 | A5.5 账号选择 + `NO_AVAILABLE_ACCOUNT` + 中途终态 `SEND_FAILED` | P0 |
| 5.9 | A5.6 `POLICY_DENIED` | P0 |
| 5.10 | A5.7 幂等键 + 被拒不计数 | P0 |
| 5.11 | A5.8 恢复：`agent_run_messages` 重建 + `pending_execution` 判定 + 同 runId 续跑 | P0 |
| 5.12 | A5.9 大小限制（8KB/200 字/2KB） | P0 |
| 5.13 | A5.10 `unreachable`/`agentEnabled` 关闭 → 当前步后 cancelled | P0 |
| 5.14 | A5.11 重复 `get_recent_messages` 策略 | P1 |
| 5.15 | `GET /api/agent-runs/:id` / `GET /api/groups/:id/agent-runs` | P0 |
| 5.16 | B1 序列：模型、预检 422、账号选择、黏性变量与 `varSources` | P0 |
| 5.17 | B1 排期 + skipped 时间戳 + 并发 201/409 | P0 |
| 5.18 | B1 重启只重排最早过期步骤 | P0 |
| 5.19 | B2 `leave-all`（群主最后退、失败账号两边都留） | P1 |
| 5.20 | B3 refresh 轮换 + 复用检测 + logout 立即失效 | P1 |
| 5.21 | B4 WS `sinceSeq` 补齐（切片 4 已做一部分）+ 前端去重 | P2 |
| 5.22 | 前端页面 1–5 + API/WS client + 401 单飞 refresh | P1 |
| 5.23 | e2e：S1–S8 全部脚本化（宿主机脚本只调 HTTP） | P1 |
| 5.24 | README 完整化：一键部署、场景复现步骤、已知取舍 | P0 |
| 5.25 | C1 媒体（选做）：下载到 `media/`、定期清理 30 天、运行中 run 用到的文件不删 | P3 |
| 5.26 | C2 真实 LLM（选做）、C3 Playwright（选做） | P3 |

---

## 第八部分：验收标准

- [ ] **S5**：网关对第一次 send 回 504、1.5 秒后落地；agent 用同一 `idempotency_key` 再调 → 网关里**恰好一条**消息；第二次返回该消息当前状态（`sent`），**不再调审计**；run 正常结束。
- [ ] **S6**：agent 依次返回坏 JSON、未知工具、然后正常结束 → run 以 `final`/`budget_exhausted`/`protocol_errors` 之一结束；服务不崩；每步都有 `kind` 和 `rawResponse`（协议错误步）。
- [ ] **S7**：并发两次启动序列 → 恰好一个 `201`、一个 `409 SEQUENCE_ALREADY_RUNNING`。
- [ ] **S8**：第 3 步有解析不了的占位符 → `422`，`error.code = UNRESOLVED_PLACEHOLDER`、`error.stepIndex = 3`、`error.key` 为该占位符名；**网关收不到任何消息**。
- [ ] A5.1：run 期间到达的非自己消息 → run 结束后**立即**创建下一次 run，且这些消息**全部**在同一 `triggerMessages` 里。
- [ ] A5.2：12 步上限、60 秒上限（**停机时间不计**，重启验证）、连续 3 次协议错误各自触发正确 `endReason`；turn 超时记 `TURN_TIMEOUT`，晚到响应被丢弃。
- [ ] A5.3：未知工具/入参不合 schema 追加 assistant 块；坏 JSON/重复 id/超时**不追加**、改追加 user text 块。
- [ ] A5.4：`pass` 才执行、`fail` → `AUDIT_REJECTED`、3 次失败 → `blocked`/`audit_blocked` 且**该工具不执行**。
- [ ] A5.5：无可用账号 → `NO_AVAILABLE_ACCOUNT`（不计协议错误、计步数）；账号中途终态 → 该步 `SEND_FAILED` 且 **run 继续**。
- [ ] A5.6：`autoKickEnabled=false` 时 `kick_user` → `POLICY_DENIED`。
- [ ] A5.7：同 run 同 key 幂等；被 `AUDIT_REJECTED`/`POLICY_DENIED` 拒绝的**不算用过 key**。
- [ ] A5.8：run 中途重启 → 同 `runId` 续跑并正常结束；**已生效的工具调用不重复执行、不记为失败**（网关消息数/成员数断言）。
- [ ] A5.9：tool_result ≤ 8KB、`resultSummary` ≤ 200 字、`rawResponse` ≤ 2KB。
- [ ] A5.10：群 `unreachable` / `agentEnabled` 关闭 → run 当前步后 `cancelled`。
- [ ] B1：账号选择规则、`skipped`、`rate_limited` 顺延；`varSources` 追踪正确；重启只重排最早过期步骤。
- [ ] B2：`leave-all` 群主最后退；失败账号在我们 DB 与网关**都仍是成员**。
- [ ] B3：refresh 轮换 + 复用即全会话作废（含已换出的新 token 与新 access token）；logout 后 access token 立即失效；前端 401 单飞。
- [ ] B4：断线重连 **3 秒内**补齐且不重复。
- [ ] 前端 5 页全部可用；`viewer` 看不到写按钮，**直接调接口得到 403**；页面 3 的 `blocked` run 醒目提示；页面 4 可看协议错误步原始响应体；页面 5 预检弹窗显示每步每 key 的取值与来源。

---

## 第九部分：风险

| 风险 | 对策 |
|---|---|
| **A5.8 恢复**：重放已生效调用（INV-3） | `pending_execution` 落库 + 幂等键 + `tool_use_id` 去重；恢复时先判定副作用是否已发生 |
| **A5.3**：两类协议错误混用 | 代码中显式分支 + 单测逐项覆盖 5 种情形 |
| **A5.4**：审计重试"不计步、不返回给 agent" | 重试循环包在单步内部，只有最终结论才产生 `tool_result` |
| **A5.2 60 秒**：重启后累计口径 | `accumulated_ms` + `last_tick_at`，停机时间自然不计 |
| **B1 重启排期**：一次性全发 | 只重排 `min(overdue step)`；其余保持"前一步发出后 + delay"的相对排期 |
| **B1 `varSources`**：黏性取值标错步骤 | 维护 `key → sourceStep` 映射，仅当**本步显式给值**时才更新 source |
| **B3 JWT 无状态**：logout/撤销后仍有效 | access token 带 `sid`，每次校验查 `sessions.revoked_at` |
| **WS 断线补齐**：补发与实时之间的空窗/重复 | "先订阅、后补发、再实时"+ 前端按 `seq` 去重 |
| 时间不够（48h） | 优先 A 组 + 页面 2/3/5；B2/B3/B4、C 组按 P1/P2/P3 顺序砍 |

---

## 第十部分：Commit 边界

按子块各一次 commit：

```
feat(agent-mock): Anthropic-shaped agent simulator with bad-behavior modes

feat(agent): agent run loop with audit, idempotency, budgets and crash recovery

feat(sequences): scheduled message sequences with precheck and sticky vars

feat(lifecycle): leave-all job with owner-last semantics

feat(auth-session): refresh token rotation with reuse detection

feat(web): operator console with 5 pages

docs(readme): one-command deploy and scenario walkthrough
```
