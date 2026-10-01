-- 0011: outbox_messages.client_msg_id / messages.client_msg_id 由 UUID 放宽为 TEXT
--
-- 背景（e2e S5 踩出）：agent 的 send_message.idempotency_key 是任意字符串
-- （agent-mock 用 "ik-1" 这种非 UUID key），execSendMessage 把它直接写入
-- outbox_messages.client_msg_id；UUID 列对非 UUID key 抛 22P02，
-- 恢复路径 findByClientMsgId 同样崩，run 热循环卡死。
--
-- clientMsgId 的语义就是"出站幂等键字符串"：
--   - API / 序列路径：后端生成的 UUID 字符串
--   - agent 路径：agent 提供的幂等键（opaque string）
-- 网关侧本来就按 opaque string 处理（by-client-id 原样匹配），放宽无影响。
-- sequence_steps.client_msg_id 只由后端生成 UUID，保持 UUID 不变。

ALTER TABLE outbox_messages ALTER COLUMN client_msg_id TYPE TEXT;
ALTER TABLE messages ALTER COLUMN client_msg_id TYPE TEXT;
