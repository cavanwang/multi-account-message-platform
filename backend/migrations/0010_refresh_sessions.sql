-- B3: refresh token 会话表
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 哈希，防泄露还原
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,           -- 绝对过期时间（较长，例如 7 天）
  revoked_at TIMESTAMPTZ                     -- 作废时间；NULL 表示有效
);

CREATE INDEX idx_refresh_sessions_user_id ON refresh_sessions(user_id);
CREATE INDEX idx_refresh_sessions_token_hash ON refresh_sessions(token_hash);
