/**
 * C1 媒体测试（规划 05 任务 5.25）。
 *
 * 覆盖：
 *  - message 事件带 mediaUrl：经 EventConsumer 下载落盘、路径回写、内容一致
 *  - 重复事件（不同 eventId 同 msgId）：只下载一次（幂等）
 *  - 媒体 404：不阻塞事件消费，路径保持 NULL
 *  - 超过大小上限（10MB）：放弃下载、不写文件
 *  - 清理：到期且无 running run → 删文件 + 置空路径（不留悬空记录）
 *  - 未到期不删；running run 关联消息受保护，run 终态后可删
 *  - DB 有路径但文件已丢失 → 清空路径不报错
 *
 * 媒体服务用测试内临时 HTTP server 模拟（不依赖 compose 容器），
 * 文件目录用每个用例独立的临时目录。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventConsumer } from '../../src/workers/event-consumer.js';
import { AgentRunRepo } from '../../src/repos/agent-runs.js';
import { cleanExpiredMedia } from '../../src/workers/media-cleaner.js';
import { MAX_MEDIA_BYTES } from '../../src/services/media-downloader.js';
import type { LoggerLike } from '../../src/services/gateway-client.js';
import { pool, resetDb, seedGroupWithMember } from '../helpers/db.js';

const silentLog: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 启动一个临时"媒体服务器"：行为由 handler 决定，返回地址与 server。 */
function startMediaServer(
  handler: (mediaId: string, res: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const m = /^\/media\/([^/]+)$/.exec(req.url ?? '');
      if (m === null) {
        res.writeHead(404);
        res.end();
        return;
      }
      handler(m[1]!, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** 往 events_inbox 插一行（模拟 SSE 已入库）。 */
async function insertInbox(eventId: number, payload: Record<string, unknown>): Promise<void> {
  await pool.query(
    'INSERT INTO events_inbox (event_id, type, payload) VALUES ($1, $2, $3::jsonb)',
    [eventId, 'message', JSON.stringify(payload)],
  );
}

/** 直接插一条带本地文件记录的消息。 */
async function insertMessageRow(
  groupId: string,
  msgId: string,
  filePath: string | null,
  downloadedAtExpr: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO messages (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at, local_file_path, media_downloaded_at)
     VALUES ($1, $2, 'pu_other', false, 't', now(), $3, ${downloadedAtExpr})`,
    [groupId, msgId, filePath],
  );
}

/** 统计目录下正式文件数（排除 .tmp 临时文件）。 */
async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir);
  return entries.filter((n) => !n.startsWith('.')).length;
}

describe('C1 媒体（media download / cleaner）', () => {
  let mediaDir: string;

  beforeEach(async () => {
    await resetDb();
    mediaDir = await mkdtemp(join(tmpdir(), 'mamp-media-'));
  });

  afterEach(async () => {
    await rm(mediaDir, { recursive: true, force: true });
  });

  it('message 事件带 mediaUrl → 下载落盘 + 路径回写 + 内容一致', async () => {
    const { groupId, gatewayGroupId } = await seedGroupWithMember('acct-1');
    const bytes = Buffer.from('hello-media-bytes', 'utf8');
    const { server, baseUrl } = await startMediaServer((id, res) => {
      if (id === 'm1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(bytes);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const consumer = new EventConsumer(
      pool, baseUrl, silentLog, { batchSize: 10 },
      {
        mediaDir,
        mediaRetentionDays: 30,
        mediaCleanIntervalSeconds: 3600,
        gatewayUrl: baseUrl,
      },
    );

    await insertInbox(1, {
      groupId: gatewayGroupId,
      msgId: 'msg-media-1',
      senderPlatformUserId: 'pu_someone_else',
      text: 't',
      sentAt: '2026-01-01T00:00:01.000Z',
      mediaUrl: '/media/m1',
    });
    expect(await consumer.runOnce()).toBe(1);

    const row = await pool.query<{
      local_file_path: string | null;
      media_downloaded_at: Date | null;
    }>(
      'SELECT local_file_path, media_downloaded_at FROM messages WHERE group_id=$1 AND msg_id=$2',
      [groupId, 'msg-media-1'],
    );
    expect(row.rows[0]?.media_downloaded_at).not.toBeNull();
    const filePath = row.rows[0]?.local_file_path;
    expect(filePath).not.toBeNull();
    expect(await countFiles(mediaDir)).toBe(1);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(filePath as string)).toEqual(bytes);

    // 事件已正常处理（processed_at 非空）
    const inbox = await pool.query('SELECT processed_at FROM events_inbox WHERE event_id=1');
    expect(inbox.rows[0]?.processed_at).not.toBeNull();

    server.close();
  });

  it('重复事件（不同 eventId 同 msgId）→ 只下载一次，路径不变', async () => {
    const { gatewayGroupId } = await seedGroupWithMember('acct-1');
    const { server, baseUrl } = await startMediaServer((_id, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x');
    });
    const consumer = new EventConsumer(
      pool, baseUrl, silentLog, { batchSize: 10 },
      {
        mediaDir,
        mediaRetentionDays: 30,
        mediaCleanIntervalSeconds: 3600,
        gatewayUrl: baseUrl,
      },
    );

    const basePayload = {
      groupId: gatewayGroupId,
      msgId: 'msg-dup-1',
      senderPlatformUserId: 'pu_other',
      text: 't',
      sentAt: '2026-01-01T00:00:01.000Z',
      mediaUrl: '/media/m1',
    };
    await insertInbox(1, basePayload);
    await insertInbox(2, basePayload);
    await consumer.runOnce();

    expect(await countFiles(mediaDir)).toBe(1);
    const { rows } = await pool.query(
      'SELECT local_file_path FROM messages WHERE msg_id=$1',
      ['msg-dup-1'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.local_file_path).not.toBeNull();

    server.close();
  });

  it('媒体 404 → 不阻塞事件消费，local_file_path 保持 NULL', async () => {
    const { groupId, gatewayGroupId } = await seedGroupWithMember('acct-1');
    const { server, baseUrl } = await startMediaServer((_id, res) => {
      res.writeHead(404);
      res.end();
    });
    const consumer = new EventConsumer(
      pool, baseUrl, silentLog, { batchSize: 10 },
      {
        mediaDir,
        mediaRetentionDays: 30,
        mediaCleanIntervalSeconds: 3600,
        gatewayUrl: baseUrl,
      },
    );
    await insertInbox(1, {
      groupId: gatewayGroupId,
      msgId: 'msg-404-1',
      senderPlatformUserId: 'pu_other',
      text: 't',
      sentAt: '2026-01-01T00:00:01.000Z',
      mediaUrl: '/media/gone',
    });
    expect(await consumer.runOnce()).toBe(1);

    const { rows } = await pool.query(
      'SELECT local_file_path FROM messages WHERE group_id=$1 AND msg_id=$2',
      [groupId, 'msg-404-1'],
    );
    expect(rows[0]?.local_file_path).toBeNull();
    expect(await countFiles(mediaDir)).toBe(0);

    server.close();
  });

  it('超过 10MB 上限 → 放弃下载，不写文件，事件正常处理', async () => {
    const { gatewayGroupId } = await seedGroupWithMember('acct-1');
    const big = Buffer.alloc(MAX_MEDIA_BYTES + 1024, 0x61);
    const { server, baseUrl } = await startMediaServer((_id, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(big);
    });
    const consumer = new EventConsumer(
      pool, baseUrl, silentLog, { batchSize: 10 },
      {
        mediaDir,
        mediaRetentionDays: 30,
        mediaCleanIntervalSeconds: 3600,
        gatewayUrl: baseUrl,
      },
    );
    await insertInbox(1, {
      groupId: gatewayGroupId,
      msgId: 'msg-big-1',
      senderPlatformUserId: 'pu_other',
      text: 't',
      sentAt: '2026-01-01T00:00:01.000Z',
      mediaUrl: '/media/big',
    });
    expect(await consumer.runOnce()).toBe(1);
    expect(await countFiles(mediaDir)).toBe(0);
    server.close();
  });

  it('到期且无 running run → 文件删除 + 路径置空', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const filePath = join(mediaDir, 'old-file.bin');
    await writeFile(filePath, 'old');
    await insertMessageRow(groupId, 'msg-old-1', filePath, "now() - interval '31 days'");

    const result = await cleanExpiredMedia(
      pool, new AgentRunRepo(pool), mediaDir, 30, silentLog,
    );
    expect(result.deleted).toBe(1);

    const { rows } = await pool.query(
      'SELECT local_file_path FROM messages WHERE msg_id=$1',
      ['msg-old-1'],
    );
    expect(rows[0]?.local_file_path).toBeNull();
    await expect(unlink(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('未到期 → 不删', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const filePath = join(mediaDir, 'new-file.bin');
    await writeFile(filePath, 'new');
    await insertMessageRow(groupId, 'msg-new-1', filePath, "now() - interval '1 day'");

    const result = await cleanExpiredMedia(
      pool, new AgentRunRepo(pool), mediaDir, 30, silentLog,
    );
    expect(result.deleted).toBe(0);
    expect(await countFiles(mediaDir)).toBe(1);
  });

  it('running run 关联的消息受保护；run 终态后可删', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const filePath = join(mediaDir, 'in-use.bin');
    await writeFile(filePath, 'in-use');
    await insertMessageRow(groupId, 'msg-run-1', filePath, "now() - interval '31 days'");

    // 建 running run 并关联该消息
    const { rows: runRows } = await pool.query<{ id: string }>(
      `INSERT INTO agent_runs (group_id, status) VALUES ($1, 'running') RETURNING id`,
      [groupId],
    );
    const runId = runRows[0]!.id;
    await pool.query(
      'INSERT INTO agent_run_pending_messages (run_id, msg_id) VALUES ($1,$2)',
      [runId, 'msg-run-1'],
    );

    const agentRunRepo = new AgentRunRepo(pool);
    const first = await cleanExpiredMedia(pool, agentRunRepo, mediaDir, 30, silentLog);
    expect(first.protected).toBe(1);
    expect(first.deleted).toBe(0);
    expect(await countFiles(mediaDir)).toBe(1);

    // run 结束 → 不再受保护
    await pool.query(`UPDATE agent_runs SET status='finished' WHERE id=$1`, [runId]);
    const second = await cleanExpiredMedia(pool, agentRunRepo, mediaDir, 30, silentLog);
    expect(second.deleted).toBe(1);
    expect(await countFiles(mediaDir)).toBe(0);
  });

  it('DB 有路径但文件已丢失 → 清空路径，不报错', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const ghostPath = join(mediaDir, `ghost-${randomUUID()}.bin`);
    await insertMessageRow(groupId, 'msg-ghost-1', ghostPath, "now() - interval '31 days'");

    const result = await cleanExpiredMedia(
      pool, new AgentRunRepo(pool), mediaDir, 30, silentLog,
    );
    expect(result.deleted).toBe(1);
    const { rows } = await pool.query(
      'SELECT local_file_path FROM messages WHERE msg_id=$1',
      ['msg-ghost-1'],
    );
    expect(rows[0]?.local_file_path).toBeNull();
  });
});
