/**
 * C1 媒体清理 worker（规划 05 任务 5.25）。
 *
 * 周期删除超过保留天数（MEDIA_RETENTION_DAYS，默认 30，按下载时刻起算）
 * 的本地媒体文件，并有两条硬约束：
 *
 *  1. **不留悬空记录**：先删文件，成功后才在独立事务置空
 *     messages.local_file_path；删除失败则保留行，下轮重试。
 *  2. **运行中的 agent run 保护**：消息仍被任一 running run 关联
 *     （agent_run_pending_messages JOIN agent_runs）时跳过；
 *     run 结束后才可能被删。
 *
 * 另外：DB 有记录但文件已经不存在（ENOENT）→ 视为已删，清空 DB 路径，
 * 不因此报错。
 */
import { unlink } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Pool } from 'pg';
import type { AgentRunRepo } from '../repos/agent-runs.js';
import {
  listExpiredMedia,
  clearMessageLocalFile,
} from '../repos/messages.js';
import type { LoggerLike } from '../services/gateway-client.js';
import { withNewTrace } from '../services/trace.js';

export interface MediaCleanerResult {
  /** 实际删除（含文件已不在）并清空记录的数量 */
  deleted: number;
  /** 因 running run 关联而跳过的数量 */
  protected: number;
}

/**
 * 执行一轮清理（独立于定时器，测试可直接调用）。
 */
export async function cleanExpiredMedia(
  pool: Pool,
  agentRunRepo: AgentRunRepo,
  mediaDir: string,
  retentionDays: number,
  log: LoggerLike,
  now: number = Date.now(),
): Promise<MediaCleanerResult> {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
  const candidates = await listExpiredMedia(pool, cutoff);
  if (candidates.length === 0) return { deleted: 0, protected: 0 };

  // 所有 running run 关联的消息 id：受保护集合
  const referenced = new Set(await agentRunRepo.listMsgIdsReferencedByRunningRuns(pool));

  const rootDir = resolve(mediaDir);
  let deleted = 0;
  let protectedCount = 0;

  for (const row of candidates) {
    if (referenced.has(row.msgId)) {
      protectedCount++;
      continue;
    }

    // 防御：只允许删除 mediaDir 之内的文件（路径必须由后端生成，双保险）
    const filePath = resolve(row.localFilePath);
    const rel = relative(rootDir, filePath);
    if (rel.startsWith('..') || rel === '') {
      log.warn({ filePath, rootDir }, 'media-cleaner: 路径越界，跳过');
      continue;
    }

    try {
      await unlink(filePath);
    } catch (err) {
      // ENOENT：文件已不在 → 按"已删"处理，继续清 DB；其他错误保留行下轮重试
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ filePath, err }, 'media-cleaner: 删除失败，保留记录下轮重试');
        continue;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await clearMessageLocalFile(client, row.groupId, row.msgId);
      await client.query('COMMIT');
      deleted++;
    } catch (dbErr) {
      await client.query('ROLLBACK').catch(() => {});
      // DB 清理失败：文件可能已删但记录还在；下轮 unlink ENOENT 会再次清记录
      log.warn({ groupId: row.groupId, msgId: row.msgId, err: dbErr },
        'media-cleaner: 清空路径失败，下轮重试');
    } finally {
      client.release();
    }
  }

  return { deleted, protected: protectedCount };
}

/** 定时包装：周期调用 cleanExpiredMedia。 */
export class MediaCleaner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly agentRunRepo: AgentRunRepo,
    private readonly mediaDir: string,
    private readonly retentionDays: number,
    private readonly intervalSeconds: number,
    private readonly log: LoggerLike,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delaySeconds: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.sweep(), delaySeconds * 1000);
  }

  private async sweep(): Promise<void> {
    try {
      // 每轮清理周期一个 trace：删除文件 / DB 清理 / 保护跳过日志共用 traceId
      const result = await withNewTrace(() => cleanExpiredMedia(
        this.pool, this.agentRunRepo, this.mediaDir, this.retentionDays, this.log,
      ));
      if (result.deleted > 0 || result.protected > 0) {
        this.log.info(result, 'media-cleaner: 本轮清理完成');
      }
    } catch (err) {
      this.log.error({ err }, 'media-cleaner: sweep 失败');
    } finally {
      this.scheduleNext(this.intervalSeconds);
    }
  }
}
