-- 切片 5：Agent 运行 / 定时序列 / 登录会话
--
-- 新增表：
--   1. agent_runs              — Agent 运行主表（同一群至多一个 running）
--   2. agent_run_messages      — 持久化对话块，崩溃恢复时重建 messages 数组
--   3. agent_steps             — 每一步的执行记录（tool_use / final / protocol_error）
--   4. agent_tool_calls        — 幂等键（同 run 同 idempotency_key 只执行一次）
--   5. agent_run_pending_messages — run 期间到达的非自己消息
--   6. sequences               — 定时序列模板
--   9. sessions                — 登录会话（B3 refresh token 轮换）
--   10. refresh_tokens         — refresh token 使用追踪
--
-- 扩列：
--   7. sequence_runs  — sequence_id / vars / step_vars / current_step_index
--   8. sequence_steps — scheduled_at / sent_at / client_msg_id / resolved_vars / var_sources

-- 1. agent_runs: Agent 运行主表
CREATE TABLE agent_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('running','finished','failed','blocked','cancelled')),
  end_reason     TEXT,   -- final|budget_exhausted|wall_clock|protocol_errors|audit_blocked|cancelled
  summary        TEXT,
  accumulated_ms INT  NOT NULL DEFAULT 0,
  last_tick_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- INV-7：同一群至多一个 running 的 agent run（DB 级保证）
CREATE UNIQUE INDEX agent_runs_one_running
  ON agent_runs (group_id) WHERE status = 'running';

COMMENT ON TABLE agent_runs IS 'Agent 运行：同一群至多一个 running（partial unique index 保证）';

-- 2. agent_run_messages: 持久化对话块，崩溃恢复时重建 messages 数组
CREATE TABLE agent_run_messages (
  id      BIGSERIAL PRIMARY KEY,
  run_id  UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('user','assistant')),
  blocks  JSONB NOT NULL
);

COMMENT ON TABLE agent_run_messages IS 'Agent 对话块持久化：恢复时按 id 升序重建 messages 数组';

-- 3. agent_steps: 每一步的执行记录
CREATE TABLE agent_steps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_no        INT  NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('tool_use','final','protocol_error')),
  tool_use_id    TEXT,               -- protocol_error 时为 NULL
  name           TEXT,
  input          JSONB,
  result_summary TEXT,
  is_error       BOOLEAN NOT NULL DEFAULT false,
  error_code     TEXT,
  audit_verdict  TEXT,
  raw_response   TEXT,               -- 截断 2KB
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_no)
);

COMMENT ON TABLE agent_steps IS 'Agent 步骤：每步执行前先落库 pending_execution，恢复时判定是否需续跑';

-- 4. agent_tool_calls: 幂等键，同 run 同 key 只执行一次
CREATE TABLE agent_tool_calls (
  run_id          UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  outbox_id       UUID REFERENCES outbox_messages(id),
  tool_use_id     TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending_execution','executed')),
  PRIMARY KEY (run_id, idempotency_key)
);

COMMENT ON TABLE agent_tool_calls IS 'Agent 工具调用幂等：已存在则查 outbox 返回当前状态，跳过审计';

-- 5. agent_run_pending_messages: run 期间到达的非自己消息
CREATE TABLE agent_run_pending_messages (
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL,
  PRIMARY KEY (run_id, msg_id)
);

COMMENT ON TABLE agent_run_pending_messages IS 'Agent run 期间到达的非自己消息，run 结束后触发新 run';

-- 6. sequences: 定时序列模板
CREATE TABLE sequences (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  steps      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sequences IS '定时序列模板：steps 为 JSON 数组，每步含 text/intervalSeconds/varSources';

-- 7. sequence_runs 扩列：关联模板 + 黏性变量 + 当前步骤
ALTER TABLE sequence_runs
  ADD COLUMN sequence_id        UUID REFERENCES sequences(id),
  ADD COLUMN vars               JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN step_vars          JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN current_step_index INT   NOT NULL DEFAULT 0;

-- 8. sequence_steps 扩列：排期时间 + 客户端消息 ID + 变量解析
ALTER TABLE sequence_steps
  ADD COLUMN scheduled_at  TIMESTAMPTZ,
  ADD COLUMN sent_at       TIMESTAMPTZ,
  ADD COLUMN client_msg_id UUID,
  ADD COLUMN resolved_vars JSONB,
  ADD COLUMN var_sources   JSONB;

-- 9. sessions: 登录会话（B3）
CREATE TABLE sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_refresh_hash TEXT,
  revoked_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sessions IS '登录会话：refresh token 轮换 + 复用检测（全会话作废）';

-- 10. refresh_tokens: refresh token 使用追踪
CREATE TABLE refresh_tokens (
  hash       TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  used_at    TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE refresh_tokens IS 'Refresh token：used_at 非空表示已使用，再次使用则作废整个 session';
