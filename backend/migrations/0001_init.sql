-- 0001_init.sql
-- 地基表：预置用户 / 操作员账号。
--
-- 约定：迁移一经应用不得修改内容（改了不会重新执行）。新增表请用新序号的迁移文件。

-- gen_random_uuid() 由 pgcrypto 提供。PostgreSQL 13+ 内建了该函数，
-- 但显式启用扩展可以让 schema 在更老的版本上也能建起来。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 控制台用户。
-- role: admin = 全部权限；viewer = 只读（写操作一律 403）。
CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE users IS '控制台用户（笔试预置 admin/viewer）';
COMMENT ON COLUMN users.role IS 'admin=全部权限；viewer=只读，写操作返回 403 FORBIDDEN';
