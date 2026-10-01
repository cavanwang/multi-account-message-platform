-- 0005_seed_accounts.sql
-- 预置 4 个测试账号（与网关模拟器的 SEED_ACCOUNTS 一致）。
-- 幂等执行：ON CONFLICT DO NOTHING。

INSERT INTO accounts (account_id, status, platform_user_id, rate_limited_until, retry_after_seconds, version)
VALUES
  ('acct-1', 'idle', NULL, NULL, NULL, 1),
  ('acct-2', 'idle', NULL, NULL, NULL, 1),
  ('acct-3', 'idle', NULL, NULL, NULL, 1),
  ('acct-4', 'idle', NULL, NULL, NULL, 1)
ON CONFLICT (account_id) DO NOTHING;

COMMENT ON TABLE accounts IS '服务账号：预置 4 个测试账号 acct-1..acct-4';
