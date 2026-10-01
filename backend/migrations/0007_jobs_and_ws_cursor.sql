-- 0007_jobs_and_ws_cursor.sql
-- 切片 4（规划 04 §4）：异步 job（建群/leave-all）、建群待加入名单、WS 投递位点。
--
-- 与规划 §4 DDL 的两处有意偏差（均为崩溃安全必需，已在计划中确认）：
--   1. jobs.payload：worker 重启后续跑必须拿到入参（creatorAccountId/memberAccountIds），
--      总则要求"服务任意时刻重启前后都成立"，故入参随 job 持久化。
--   2. group_job_members.join_requested_at：JOIN_TIMEOUT（10s）由持久化定时器判定，
--      重启后判定需要知道"何时发出的 join 请求"，仅有 joined_at 不够。
--
-- 注意：规划 §4 的 groups.agent_enabled / auto_kick_enabled 已在 0004 建好，此处跳过。

-- ============================================================
-- jobs: 异步任务表（建群 / leave-all）
-- ============================================================
CREATE TABLE jobs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT        NOT NULL CHECK (kind IN ('create_group', 'leave_all')),
  status     TEXT        NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'finished', 'failed')),
  -- 建群入参：{ creatorAccountId, memberAccountIds[] }（文本 account_id，与 API 契约一致）
  payload    JSONB       NOT NULL,
  -- [{ step, code }]，step ∈ create | invite | join:<accountId> | promote | leave:<accountId>
  -- errors 非空 → job failed（题目 §5 GET /api/jobs/:jobId 约定）
  errors     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE jobs IS '异步任务：建群 / leave-all。errors 非空即 failed';
COMMENT ON COLUMN jobs.payload IS '任务入参（JSON），重启恢复必需';
COMMENT ON COLUMN jobs.errors IS '失败步骤列表 [{step, code}]；非空 → status=failed';

-- ============================================================
-- group_job_members: 建群 job 的待加入名单与 promote 计数
-- ============================================================
CREATE TABLE group_job_members (
  job_id             UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id         UUID        NOT NULL REFERENCES accounts(id),
  -- 发出网关 join 请求的时刻（持久化 JOIN_TIMEOUT 判定基准；未发出时为 NULL）
  join_requested_at  TIMESTAMPTZ,
  -- 收到 member_joined 的时刻（NULL = 尚未入群）
  joined_at          TIMESTAMPTZ,
  -- promote 调用计数（硬上限 2 次，题目 A2 错误表 NOT_MEMBER_YET 行）
  promote_calls      SMALLINT    NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, account_id)
);

COMMENT ON TABLE group_job_members IS '建群 job 的成员进度：join 请求时刻 / 入群时刻 / promote 次数';
COMMENT ON COLUMN group_job_members.join_requested_at IS 'JOIN_TIMEOUT 持久化判定基准（重启后仍有效）';

-- ============================================================
-- ws_push_cursor: WS 投递位点（单行表）
-- ============================================================
-- 投递 worker 轮询 web_events 中 seq > last_pushed_seq 的行推给已认证连接，
-- 推完推进位点。崩溃重启后从位点续推，保证 at-least-once（前端按 seq 去重）。
CREATE TABLE ws_push_cursor (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_pushed_seq BIGINT   NOT NULL DEFAULT 0
);

INSERT INTO ws_push_cursor (id, last_pushed_seq) VALUES (1, 0);

COMMENT ON TABLE ws_push_cursor IS 'WS 投递位点（单行）：已推送的最大 web_events.seq';
