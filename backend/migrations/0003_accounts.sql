-- 0003_accounts.sql
-- 服务账号表：记录账号在后端侧的状态、connect 后拿到的 platformUserId、以及限流到期时间。
--
-- 状态机（需求 §3）：
--   idle → online（connect 成功）→ disconnected（主动断开）
--   online → rate_limited（网关返回 429）→ online（到期或人工解除）
--   任意状态 → suspended / session_expired（终态，不可逆）
--
-- 终态原子后果（需求 A3）：
--   进入 suspended / session_expired 后，后端会：
--    1. 调用网关 /_mock 端点让网关也把账号标记为终态
--    2. 网关自动把账号移出所有群并推 member_left
--    3. 后端监听到 member_left 后删除本地成员记录
--   这三步必须"要么都完成、要么都不做"——用 saga 模式 + 幂等保证最终一致。

CREATE TABLE accounts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           TEXT        NOT NULL UNIQUE,
  platform_user_id     TEXT        NULL,  -- connect 成功后填充；网关确定性派生，后端只读
  status               TEXT        NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'online', 'disconnected', 'rate_limited', 'suspended', 'session_expired')),
  rate_limited_until   TIMESTAMPTZ NULL,  -- 限流到期时间；NULL 表示未限流
  retry_after_seconds  INTEGER     NULL,  -- 最近一次 429 返回的 retryAfterSeconds，供前端展示
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  version              INTEGER     NOT NULL DEFAULT 1  -- 乐观锁版本号，用于 CAS 转移
);

CREATE INDEX idx_accounts_status ON accounts (status) WHERE status != 'idle';
CREATE INDEX idx_accounts_rate_limited_until ON accounts (rate_limited_until) WHERE rate_limited_until IS NOT NULL;

COMMENT ON TABLE accounts IS '服务账号：后端管理的账号状态、platformUserId、限流到期时间';
COMMENT ON COLUMN accounts.version IS 'CAS 版本号：每次状态转移时 version+1，避免并发覆盖';
COMMENT ON COLUMN accounts.platform_user_id IS '网关派生的平台用户 ID，只读（connect 成功后填充）';
COMMENT ON COLUMN accounts.status IS 'idle=未连接 online=在线 disconnected=已断开 rate_limited=限流中 suspended/session_expired=终态';
