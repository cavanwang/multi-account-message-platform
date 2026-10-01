-- C1 媒体文件（选做，5.25）：
--   message 事件带 mediaUrl 时，后端把文件下载到本地 media/ 目录，
--   路径记入 messages.local_file_path；定期删除超 MEDIA_RETENTION_DAYS（默认 30）
--   的文件。删除后不能留下指向已删文件的记录；仍被运行中 agent run 用到的文件不删。

-- 本地文件路径（MEDIA_DIR 下的相对/绝对路径）；未下载或已被清理时为 NULL。
-- IF NOT EXISTS：兼容手工/残留导致的列已存在状态，使迁移仍可补记版本。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS local_file_path TEXT;

-- 下载完成时刻：清理 worker 按"下载时刻"判龄，而不是消息 sent_at
-- （一条很旧的消息刚被下载，不应立刻被判超期删掉）。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_downloaded_at TIMESTAMPTZ;

COMMENT ON COLUMN messages.local_file_path IS
  'C1 媒体：下载到本地 media/ 的文件路径；NULL=未下载或已清理';
COMMENT ON COLUMN messages.media_downloaded_at IS
  'C1 媒体：下载完成时刻，清理按它判龄（默认保留 30 天）';
