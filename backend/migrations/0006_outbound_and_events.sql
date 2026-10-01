-- 0006_outbound_and_events.sql
-- 切片 3 任务 3.1：出站投递与事件消费的数据模型。
--
-- 新增四张表：
--   - messages                消息时间线展示行（一条消息只有一行，(group_id, msg_id) 唯一）
--   - events_inbox            网关事件收件箱（先落库再处理：去重、可重放、不丢内容，INV-4）
--   - events_cursor           SSE 游标（单行表，断流/停机后 since 补齐，INV-4）
--   - pending_reconciliations 504 收敛任务（持久化定时器，崩溃安全，§2.3）
--
-- 注：outbox_messages 的 generation / resend_count 列与 web_events 表均已在 0004 建好，本迁移不涉及。

-- ============================================================
-- messages: 消息时间线（展示用；与 outbox_messages 通过 client_msg_id / gateway_msg_id 关联）
-- ============================================================
CREATE TABLE messages (
  msg_id                  TEXT        NOT NULL,  -- 网关 msgId
  group_id                UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  client_msg_id           UUID,                   -- 自己发的才有，关联 outbox_messages.client_msg_id
  sender_platform_user_id TEXT        NOT NULL,
  is_own                  BOOLEAN     NOT NULL DEFAULT false,
  text                    TEXT        NOT NULL,
  sent_at                 TIMESTAMPTZ NOT NULL,
  media_url               TEXT,
  local_file_path         TEXT,                   -- C1 用，先留位
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, msg_id)
);

-- 时间线游标分页：按 sentAt 倒序、msgId 破平（sentAt 毫秒精度，同一毫秒可能多条）
CREATE INDEX messages_timeline_idx ON messages (group_id, sent_at DESC, msg_id DESC);

COMMENT ON TABLE messages IS '消息时间线展示行：一条消息只有一行（message_sent 与回流 message 写同一行）';
COMMENT ON COLUMN messages.client_msg_id IS '我们自己生成的幂等键，仅自发消息有值，关联 outbox';
COMMENT ON COLUMN messages.is_own IS '服务账号自己发出的消息（senderPlatformUserId 命中本服务账号）';
COMMENT ON COLUMN messages.local_file_path IS '媒体文件本地缓存路径（C1 用，留位）';

-- ============================================================
-- events_inbox: 网关事件收件箱（INV-4：先落库再处理，at-least-once + 去重 + 可重放）
-- ============================================================
CREATE TABLE events_inbox (
  event_id     BIGINT      PRIMARY KEY,  -- 网关 eventId，去重键（重复推送只入一行）
  type         TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,              -- NULL = 待处理；处理成功才置时间
  attempts     INT         NOT NULL DEFAULT 0,
  last_error   TEXT                      -- 处理失败时的错误；不置 processed_at，下轮重试
);

-- consumer worker 轮询待处理事件的索引
CREATE INDEX events_inbox_pending_idx ON events_inbox (event_id) WHERE processed_at IS NULL;

COMMENT ON TABLE events_inbox IS '网关事件收件箱：SSE 帧先落库再消费，崩溃不丢、重复去重、可重放';
COMMENT ON COLUMN events_inbox.event_id IS '网关 eventId，全局单调递增，去重键';
COMMENT ON COLUMN events_inbox.processed_at IS '处理成功才置；失败的行保留 last_error 等待重试';

-- ============================================================
-- events_cursor: SSE 消费游标（单行表；重连时 since=last_seen_event_id 补拉）
-- ============================================================
CREATE TABLE events_cursor (
  id                  SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seen_event_id  BIGINT      NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 单行表在迁移内插入初始行，代码层不必处理"行不存在"分支
INSERT INTO events_cursor (id, last_seen_event_id) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE events_cursor IS 'SSE 消费游标：单行表，断流/停机后重连带 since 补拉（since 为独占语义）';

-- ============================================================
-- pending_reconciliations: 504 收敛任务（持久化定时器，崩溃后重跑）
-- ============================================================
CREATE TABLE pending_reconciliations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id  UUID        NOT NULL REFERENCES outbox_messages(id) ON DELETE CASCADE,
  kind       TEXT        NOT NULL CHECK (kind IN ('resolve_504', 'retry_offline')),
  due_at     TIMESTAMPTZ NOT NULL,  -- 到期时间，worker 轮询拾取
  attempts   INT         NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pending_recon_due_idx ON pending_reconciliations (due_at);

COMMENT ON TABLE pending_reconciliations IS '504 收敛任务：收到 504 后落库定时任务，by-client-id 确认/重发，5 秒硬约束';
COMMENT ON COLUMN pending_reconciliations.kind IS 'resolve_504=504 未知态收敛；retry_offline=离线重试（预留）';
