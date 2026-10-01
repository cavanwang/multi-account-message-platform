-- 0004_groups_and_outbox.sql
-- 建群、成员、出站消息、序列运行、WS 事件相关表。
--
-- 这些表是为了支撑"终态原子后果"（切片 2 §5）：
--   - 进入终态时：移出所有群、取消排队消息、跳过序列步骤
-- 以及后续切片的功能：
--   - 切片 3：outbox_messages 用于出站投递状态机
--   - 切片 4：groups / group_members 用于建群
--   - 切片 5：sequence_runs / sequence_steps 用于定时序列
--
-- 聚合根架构（见项目记忆）：
--   - 聚合根（有 version）：accounts, groups, sequence_runs, outbox_messages
--   - 关联表（无 version）：group_members, sequence_steps

-- ============================================================
-- groups: 群表
-- ============================================================
CREATE TABLE groups (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_group_id     TEXT        NOT NULL UNIQUE,  -- 网关返回的 groupId
  status               TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'unreachable', 'left')),
  creator_account_id   UUID        NOT NULL REFERENCES accounts(id),
  agent_enabled        BOOLEAN     NOT NULL DEFAULT false,
  auto_kick_enabled    BOOLEAN     NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  version              INTEGER     NOT NULL DEFAULT 1  -- CAS 版本号
);

COMMENT ON TABLE groups IS '群：网关 groupId 映射、状态、是否启用 agent/autoKick';
COMMENT ON COLUMN groups.status IS 'active=正常 unreachable=群不可写 left=已全部退群';

-- ============================================================
-- group_members: 群成员表（关联表，无 version）
-- ============================================================
CREATE TABLE group_members (
  group_id           UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id         UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform_user_id   TEXT        NOT NULL,  -- 冗余存储，便于按网关 platformUserId 反查
  role               TEXT        NOT NULL CHECK (role IN ('creator', 'admin', 'member')),
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);

CREATE INDEX idx_group_members_platform_user_id ON group_members (platform_user_id);

COMMENT ON TABLE group_members IS '群成员：服务账号在群中的角色';
COMMENT ON COLUMN group_members.platform_user_id IS '冗余存储网关的 platformUserId，用于反查';

-- ============================================================
-- outbox_messages: 出站消息 outbox（聚合根，有 version）
-- ============================================================
CREATE TABLE outbox_messages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id        UUID        NOT NULL REFERENCES accounts(id),
  client_msg_id     UUID        NOT NULL UNIQUE,  -- 幂等键：我们生成的 UUID
  text              TEXT        NOT NULL,
  delivery_status   TEXT        NOT NULL CHECK (delivery_status IN
                    ('queued', 'accepted', 'sent', 'failed', 'unknown', 'cancelled')),
  fail_code         TEXT,  -- failed/cancelled 时必填
  origin            TEXT        NOT NULL CHECK (origin IN ('api', 'agent', 'sequence')),
  resend_count      SMALLINT    NOT NULL DEFAULT 0,  -- 已向网关发出的 HTTP 次数（504 重发用）
  generation        SMALLINT    NOT NULL DEFAULT 0,  -- 已发出的 HTTP 请求次数
  accepted_at       TIMESTAMPTZ,
  gateway_msg_id    TEXT,  -- 网关返回的 msgId（message_sent 后填充）
  sent_at           TIMESTAMPTZ,  -- 网关的 sentAt（message_sent 后填充）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INTEGER     NOT NULL DEFAULT 1,  -- CAS 版本号
  CHECK (delivery_status NOT IN ('failed', 'cancelled') OR fail_code IS NOT NULL)
);

CREATE INDEX idx_outbox_pending ON outbox_messages (account_id, created_at)
  WHERE delivery_status IN ('queued', 'unknown');
CREATE INDEX idx_outbox_client_msg_id ON outbox_messages (client_msg_id);

COMMENT ON TABLE outbox_messages IS '出站消息 outbox：先落库再发网关，保证崩溃安全（INV-1/2）';
COMMENT ON COLUMN outbox_messages.client_msg_id IS '幂等键：我们生成的 UUID，发前就持久化';
COMMENT ON COLUMN outbox_messages.delivery_status IS 'queued→accepted→sent|failed|unknown|cancelled';
COMMENT ON COLUMN outbox_messages.generation IS '已向网关发出 HTTP 的次数，用于 504 重发控制';

-- ============================================================
-- sequence_runs: 序列运行表（聚合根，有 version）
-- ============================================================
CREATE TABLE sequence_runs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'stopped')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER     NOT NULL DEFAULT 1
);

-- 同一群至多一个 running 的序列运行（INV-7 的 DB 级保证）
CREATE UNIQUE INDEX idx_sequence_runs_one_running
  ON sequence_runs (group_id) WHERE status = 'running';

COMMENT ON TABLE sequence_runs IS '序列运行：同一群至多一个 running（partial unique index 保证）';

-- ============================================================
-- sequence_steps: 序列步骤表（关联表，无 version）
-- ============================================================
CREATE TABLE sequence_steps (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID        NOT NULL REFERENCES sequence_runs(id) ON DELETE CASCADE,
  step_index       INT         NOT NULL,
  status           TEXT        NOT NULL CHECK (status IN
                     ('pending', 'accepted', 'sent', 'skipped', 'failed')),
  outbox_id        UUID        REFERENCES outbox_messages(id),  -- 关联的出站消息
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index)
);

COMMENT ON TABLE sequence_steps IS '序列步骤：每步的状态和关联的 outbox 消息';

-- ============================================================
-- web_events: WebSocket 推送事件表
-- ============================================================
CREATE TABLE web_events (
  seq        BIGSERIAL   PRIMARY KEY,  -- 全局单调递增，用于 WS 推送和断线补齐
  type       TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE web_events IS 'WS 事件：事务内插入，提交后投递（INV-5）';
COMMENT ON COLUMN web_events.seq IS '全局单调递增序列，用于 WS 推送和 sinceSeq 补齐';
