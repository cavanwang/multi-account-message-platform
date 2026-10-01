/**
 * Agent Run 执行 worker。
 *
 * 轮询 agent_runs 表中的 running 行，调用 runAgent 执行整个 run。
 * 多实例防护：pg_try_advisory_lock(hashtext(run_id))，拿不到锁直接跳过。
 */
import type { Pool } from 'pg';
import type { LoggerLike } from '../services/gateway-client.js';
import type { AgentRunnerDeps } from '../services/agent-runner.js';
import { runAgent } from '../services/agent-runner.js';
import type { AgentRunRepo } from '../repos/agent-runs.js';
import { withNewTrace } from '../services/trace.js';

export interface AgentRunnerWorkerOptions {
  /** 扫描间隔（毫秒），默认 200。 */
  intervalMs?: number;
}

export class AgentRunnerWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: AgentRunnerDeps,
    private readonly options: AgentRunnerWorkerOptions = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const intervalMs = this.options.intervalMs ?? 200;
    this.timer = setTimeout(() => void this.sweep(), intervalMs);
  }

  private async sweep(): Promise<void> {
    try {
      const runs = await this.findRunningRuns();
      for (const runId of runs) {
        await this.executeWithLock(runId);
      }
    } catch (err) {
      this.deps.log.error({ err }, '[AgentRunnerWorker] sweep 失败');
    } finally {
      this.scheduleNext();
    }
  }

  /** 查询所有 running 的 run id。 */
  private async findRunningRuns(): Promise<string[]> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE status = 'running' ORDER BY created_at ASC`,
    );
    return rows.map((r) => r.id);
  }

  /** 用 advisory lock 包裹执行，保证多实例下同一 run 只被一个 worker 执行。 */
  private async executeWithLock(runId: string): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [runId],
      );
      if (!rows[0]!.locked) return; // 其他实例正在执行

      // 单次 runAgent 执行（可能包含多轮 turn / audit / 工具调用）共用一个
      // traceId；run 若跨 tick 恢复执行，每次 sweep 开启新 trace
      await withNewTrace(() => runAgent(this.deps, runId));
    } catch (err) {
      this.deps.log.error({ runId, err }, '[AgentRunnerWorker] runAgent 失败');
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [runId]).catch(() => {});
      client.release();
    }
  }
}
