-- 切片 4 批次 2：建群 job 执行器 —— job → group 反向关联
--
-- 目的：
--   1. worker 建群成功后把 gateway_group_id 写回 jobs 关联（created_by_job_id），
--      重启恢复时通过 findByJobId 判定"create 步骤是否已完成"，避免重复建群；
--   2. UNIQUE 约束兜底：即使并发/重试导致逻辑误判，DB 层强制一个 job 只建一个群。

ALTER TABLE groups
  ADD COLUMN created_by_job_id UUID REFERENCES jobs(id);

-- UNIQUE 索引天然允许任意多行 NULL（未关联 job 的群，如未来手动录入）
CREATE UNIQUE INDEX groups_created_by_job_id_uniq
  ON groups (created_by_job_id)
  WHERE created_by_job_id IS NOT NULL;
