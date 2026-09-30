# 切片 2：账号状态机 + CAS + 终态原子后果

> 上游依据：`docs/examination_project.md` §3.1、`docs/requirements.md` §5 A1
> 独立 commit：**是**。
> 前置：切片 0、切片 1。
> 说明：本切片实现 A1 的**纯逻辑 + 端点 + 持久化**，但终态后果需要"取消排队消息 / 跳过序列步骤"，因此本切片**同时落地 outbox 与序列步骤的最小表结构**（见 §4.3），把原子事务一次做对；切片 3 填充 outbox 的发送逻辑，切片 5 填充序列逻辑。

---

## 1. 目标与范围

1. 账号状态转移表（6 态）与"表上没有的转移一律非法"的规则。
2. 并发变更的**比较并交换（CAS）**语义。
3. `rateLimitedUntil` 的刷新与自动恢复（**不算状态转移**）。
4. **终态原子后果**（四种来源统一）：移出所有群、取消排队消息、跳过序列步骤、推 `account_terminal`。
5. `GET /api/accounts`、`POST /api/accounts/:id/connect`、`POST /api/accounts/:id/transition`。

---

## 2. 状态转移表（权威，代码与测试共用同一份常量）

行 = 当前，列 = 目标；✔ = 合法：

| 从 \ 到 | idle | online | rate_limited | disconnected | suspended | session_expired |
|---|---|---|---|---|---|---|
| **idle** | | ✔ | | | ✔ | ✔ |
| **online** | ✔ | | ✔ | ✔ | ✔ | ✔ |
| **rate_limited** | | ✔ | | ✔ | ✔ | ✔ |
| **disconnected** | ✔ | ✔ | | | ✔ | ✔ |
| **suspended** | | | | | | |
| **session_expired** | | | | | | |

**规则**：
- `suspended` / `session_expired` 是**终态**，无出边。
- **重复进入同一终态 → 静默忽略**（不报错、不重复触发后果、不影响后续事件处理）。
- 表上没有的转移（**包括同状态到同状态**）→ `409 ILLEGAL_TRANSITION`。
- 该表以 `domain/account-status.ts` 中的 `Map<AccountStatus, Set<AccountStatus>>` 为唯一来源，端点、worker、测试均引用它。

---

## 3. 对外契约

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /api/accounts` | — | `200 [{ id, status, platformUserId, rateLimitedUntil }]` | — |
| `POST /api/accounts/:id/connect` | — | `200 { status, platformUserId }` | `401/403`（鉴权）；网络错 |
| `POST /api/accounts/:id/transition` | `{ to, expectedFrom }` 均必填 | `200 { status }` | `400 VALIDATION_ERROR` / `404 ACCOUNT_NOT_FOUND` / `409 ILLEGAL_TRANSITION` / `409 CAS_CONFLICT` |

**`connect` 语义**：调网关 `connect` → 保存返回的 `platformUserId` → `idle`/`disconnected` → `online`。
- `platformUserId` 一经保存不再改变（网关保证幂等）。
- 账号处于终态 → 直接返回网关的同码错误（`403 ACCOUNT_SUSPENDED` / `401 SESSION_EXPIRED`），**不做状态转移**。

**`transition` 语义**：
1. 校验 `to ∈ 状态集`、`expectedFrom ∈ 状态集`、`expectedFrom ≠ to`（`to === expectedFrom` 属非法转移，交给转移表判定 → `ILLEGAL_TRANSITION`）→ 否则 `400`。
2. 校验 `expectedFrom → to` 在转移表内 → 否则 `409 ILLEGAL_TRANSITION`。
3. **CAS 更新**：`UPDATE accounts SET status = $to WHERE id = $id AND status = $expectedFrom`；影响行数 0 → `409 CAS_CONFLICT`。
4. 目标为 `disconnected` / `idle` → 调网关 `disconnect`（失败不回滚状态，记 `inconsistency`）。
5. 目标为 `suspended` / `session_expired` → 走 §5 终态事务。
6. 提交后推 `account_status_changed { accountId, from, to }`。

**`rate_limited` 的进入**：由网关 `429 RATE_LIMITED { retryAfterSeconds }` 触发（切片 3 调用），`rateLimitedUntil = now + retryAfterSeconds`。
- **`rateLimitedUntil` 的刷新不算状态转移**，也不推 `account_status_changed`（仅在 `online → rate_limited` 这一次推）。
- 等待期内该账号的 `send` 不再发往网关；到期后**自动回到 `online`**。
- 到期时若账号已不是 `rate_limited`（被操作员标记离线等）→ **不做转移**。

**自动恢复的实现（崩溃安全）**：不依赖内存 timer，用一个 **1 秒周期的 sweep worker**：
```sql
UPDATE accounts SET status='online', rate_limited_until=NULL
WHERE status='rate_limited' AND rate_limited_until <= now()
RETURNING id;
```
对每个受影响账号推 `account_status_changed`。重启后天然继续。

---

## 4. 数据模型

### 4.1 accounts

```sql
CREATE TABLE accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_account_id TEXT NOT NULL UNIQUE,      -- 预置，传给网关的 accountId
  status             TEXT NOT NULL CHECK (status IN
                       ('idle','online','rate_limited','disconnected','suspended','session_expired')),
  platform_user_id   TEXT,
  rate_limited_until TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX accounts_status_idx ON accounts (status)
  WHERE status IN ('rate_limited');               -- sweep worker 用
```

- **预置账号**：migration 幂等插入 4 个账号（`acct-1..acct-4`），初始 `status='idle'`、`platform_user_id=NULL`（与网关 seed 一致）。
- 状态非法组合用 `CHECK` 兜底：`status IN ('suspended','session_expired')` 是终态，无需额外列。
- `CHECK (status <> 'rate_limited' OR rate_limited_until IS NOT NULL)` 防止漏设到期时间。

### 4.2 CAS 与"不能后写覆盖先写"

CAS 靠 `WHERE status = expectedFrom` 实现，天然满足"至多一个成功"。**必须在事务内立即读取影响行数**，不得先 `SELECT` 再 `UPDATE`（有 TOCTOU 窗口）。

### 4.3 终态后果所需的表（本切片建，后续切片填充）

```sql
-- 群与服务账号成员：切片 4 补全字段，这里先建足以承载"移出所有群"
CREATE TABLE groups (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_group_id   TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','unreachable','left')),
  creator_account_id UUID NOT NULL REFERENCES accounts(id),
  agent_enabled      BOOLEAN NOT NULL DEFAULT false,
  auto_kick_enabled  BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id           UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform_user_id   TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('creator','admin','member')),
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);

-- 出站消息 outbox：切片 3 使用，本切片建表供终态"取消排队消息"
CREATE TABLE outbox_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id),
  client_msg_id     UUID NOT NULL UNIQUE,
  text              TEXT NOT NULL,
  delivery_status   TEXT NOT NULL CHECK (delivery_status IN
                      ('queued','accepted','sent','failed','unknown','cancelled')),
  fail_code         TEXT,
  origin            TEXT NOT NULL CHECK (origin IN ('api','agent','sequence')),
  resend_count      SMALLINT NOT NULL DEFAULT 0,
  accepted_at       TIMESTAMPTZ,
  gateway_msg_id    TEXT,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (delivery_status NOT IN ('failed','cancelled') OR fail_code IS NOT NULL)
);
CREATE INDEX outbox_pending_idx ON outbox_messages (account_id, created_at)
  WHERE delivery_status IN ('queued','unknown');

-- 序列 / 序列步骤：切片 5 填充，本切片建表供终态"跳过序列步骤"
CREATE TABLE sequence_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('running','finished','failed','stopped')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sequence_steps (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES sequence_runs(id) ON DELETE CASCADE,
  step_index       INT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('pending','accepted','sent','skipped','failed')),
  outbox_id        UUID REFERENCES outbox_messages(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index)
);
-- 同一群至多一个 running 的序列运行（INV-7 的 DB 级保证）
CREATE UNIQUE INDEX sequence_runs_one_running
  ON sequence_runs (group_id) WHERE status = 'running';
```

> 成员唯一性用复合主键 `(group_id, account_id)`；`platform_user_id` 冗余存一份，便于按网关的 `platformUserId` 反查账号。

---

## 5. 终态后果（单事务，四种来源共用同一函数）

入口：`services/account-terminal.ts#markTerminal(accountId, toStatus, source)`，`source ∈ {send_error, gateway_event, operator, agent}`。**无论来源，结果一致**：

```
BEGIN;
  -- 1) CAS 进入终态；已在该终态 → 直接 COMMIT 返回（静默忽略）
  UPDATE accounts SET status=$to, updated_at=now()
    WHERE id=$id AND status <> $to AND status NOT IN ('suspended','session_expired');
  -- 2) 移出所有群
  DELETE FROM group_members WHERE account_id=$id RETURNING group_id;
  -- 3) 排队中的发送 → cancelled
  UPDATE outbox_messages SET delivery_status='cancelled',
         fail_code='ACCOUNT_TERMINAL', updated_at=now()
    WHERE account_id=$id AND delivery_status IN ('queued','unknown');
  -- 4) 对应的序列步骤 → skipped（有时间戳，进度照常推进）
  UPDATE sequence_steps SET status='skipped', updated_at=now()
    WHERE outbox_id IN (SELECT id FROM outbox_messages
                        WHERE account_id=$id AND delivery_status='cancelled')
      AND status IN ('pending','accepted');
  -- 5) 出队事件（本地表，与事务同提交）
  INSERT INTO web_events (type, payload) VALUES
    ('account_terminal', jsonb_build_object('accountId',$id,'status',$to));
COMMIT;
-- 提交后再投递 WS（切片 4 实现），保证"推给前端的状态事件对应已持久化的状态"
```

**原子性边界**：以上 5 步在同一事务内；**网关调用不放进事务**（`disconnect` 由调用方在提交后执行，失败只记 `inconsistency`）。

**并发保护**：对 `accountId` 取 `pg_advisory_xact_lock(hashtext(accountId))`，避免两个来源同时触发导致重复扣减 / 重复推事件。

---

## 6. 任务拆解

| # | 任务 | 产出 | 优先级 |
|---|---|---|---|
| 2.1 | `domain/account-status.ts`：状态常量 + 转移表 + `isLegalTransition()` | 纯函数，可单测 | P0 |
| 2.2 | migration：`accounts` + 预置 4 账号（幂等） | — | P0 |
| 2.3 | migration：`groups` / `group_members` / `outbox_messages` / `sequence_runs` / `sequence_steps` + 两处 partial unique index | 终态后果可落地 | P0 |
| 2.4 | `repos/accounts.ts`：CAS 更新、按状态查询 | — | P0 |
| 2.5 | `services/account-terminal.ts`：§5 的原子事务（含 advisory lock） | 单测覆盖四种来源 | P0 |
| 2.6 | `POST /api/accounts/:id/transition` + 错误映射 | 全错误码 | P0 |
| 2.7 | `GET /api/accounts` | — | P0 |
| 2.8 | `POST /api/accounts/:id/connect`（调网关 connect、保存 platformUserId） | — | P0 |
| 2.9 | `workers/rate-limit-sweeper.ts`：1s 周期到期恢复 | 崩溃安全 | P0 |
| 2.10 | `web_events` 表 + 事务内入队的 helper（切片 4 消费） | — | P0 |
| 2.11 | 单测：转移表**全 36 格**枚举、同状态转移、重复终态幂等、CAS 并发 | — | P0 |
| 2.12 | 单测：终态后果四种来源结果一致且原子（注入中途失败回滚） | — | P0 |

---

## 7. 验收标准

- [ ] 转移表 6×6 = 36 种组合逐一测试：✔ 的 13 种成功，其余 23 种（含 6 种同状态）全部 `409 ILLEGAL_TRANSITION`。
- [ ] 两个并发 `transition` 带同一 `expectedFrom` → **恰好一个 200、一个 409 CAS_CONFLICT**，最终状态 = 成功那次的 `to`（无覆盖）。
- [ ] `action=suspended` 后再 `transition { to: 'online' }` → `409 ILLEGAL_TRANSITION`。
- [ ] 重复标记同一终态 → 幂等，第二次无错误、无重复 `account_terminal`。
- [ ] 账号在 3 个群里 + 有 2 条 `queued` 出站 + 有 1 个 pending 序列步骤 → 标记终态后：成员 0 行、2 条 `cancelled(ACCOUNT_TERMINAL)`、1 条 `skipped`、1 条 `account_terminal` 事件，**且全部在同一事务**（人为让第 4 步失败 → 全部回滚）。
- [ ] 终态的四个来源（发送 403、网关 `account_status` 事件、操作员 transition、agent 中途终态）产生的 DB 结果**逐字段一致**。
- [ ] `rate_limited` 账号到期后 ≤2 秒自动回 `online`；到期前被标记 `disconnected` → 不自动恢复。
- [ ] 服务在 `rate_limited` 期间重启 → 重启后仍能按时恢复（sweep worker 不依赖内存）。
- [ ] `connect` 一个终态账号 → 返回网关同码错误，状态不变。

---

## 8. 风险

| 风险 | 对策 |
|---|---|
| CAS 写成 `SELECT` + `UPDATE` 两段 → 并发覆盖 | 强制单条 `UPDATE ... WHERE status=...`，repo 层只暴露 CAS 方法，禁止裸更新状态 |
| 终态后果分散在多个调用点 → 行为不一致 | 只允许通过 `markTerminal()` 进入终态，所有来源调用同一函数；code review 检查无其他 `status='suspended'` 写入 |
| 重复触发终态导致重复扣减 | 入口先 CAS，已在终态则早退；再加 `pg_advisory_xact_lock` |
| `rate_limited` 用内存 timer → 重启丢失 | sweep worker 全量扫描 `rate_limited_until <= now()` |
| 提前建 `groups`/`sequence_*` 表，切片 4/5 又要改 | 本切片只建**承载后果所需的最小列**；切片 4/5 用新 migration 增量加列，不改已有列语义 |

---

## 9. Commit 边界

一次 commit：

```
feat(accounts): account state machine with CAS and atomic terminal consequences

- full 6-state transition table, same-state and missing edges are illegal
- compare-and-swap transitions, no lost updates under concurrency
- terminal state atomically removes memberships, cancels queued sends and
  skips sequence steps in one transaction
- crash-safe rate-limit auto-recovery sweep
```
