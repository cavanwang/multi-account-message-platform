-- 0012: agent_tool_calls 增加 client_msg_id 列
--
-- 背景（e2e S5 踩出）：agent 的 idempotency_key 只在 (run_id, key) 维度唯一，
-- 不能当作全局唯一的 outbox_messages.client_msg_id（agent-mock 每个 run 的
-- 首次 send 都用 "ik-1"，跨 run 必撞全局唯一约束）。
--
-- 修正后的映射关系：
--   - outbox.client_msg_id 一律由后端生成（UUID 字符串）
--   - agent_tool_calls.client_msg_id 记录本次调用入队时生成的 clientMsgId，
--     崩溃恢复（pending_execution）按它定位"已入队未标记"的孤儿 outbox 行
ALTER TABLE agent_tool_calls ADD COLUMN client_msg_id TEXT;

COMMENT ON COLUMN agent_tool_calls.client_msg_id IS '入队 outbox 时后端生成的 clientMsgId；崩溃恢复按它定位孤儿 outbox 行（INV-3）';
