-- 0002_seed_users.sql
-- 预置两个控制台用户：admin/admin（全权限）、viewer/viewer（只读）。
--
-- 幂等：使用 ON CONFLICT DO NOTHING，重复执行不会报错、也不会覆盖已改过的口令。
-- 口令哈希由 `npm run seed:hash -- <password>` 生成（bcrypt, cost=10）。
-- 如需更换口令：生成新哈希 → 写一个新的迁移文件做 UPDATE，不要修改本文件。

-- 下面的哈希由 `npm run seed:hash -- admin` / `-- viewer` 生成并核对过：
--   bcrypt.compareSync('admin',  adminHash)  === true
--   bcrypt.compareSync('viewer', viewerHash) === true
INSERT INTO users (username, password_hash, role) VALUES
  ('admin',  '$2a$10$.0N8crjyRK.DaFVoVUgR1.yGkRPz4aRsNYnR0GLCUn6faOp1QqWbW', 'admin'),
  ('viewer', '$2a$10$z/QYanhJvxFg56oz5A64hOcFZsX.7.Aw/Da18eixhet9i0C.AgpY.', 'viewer')
ON CONFLICT (username) DO NOTHING;
