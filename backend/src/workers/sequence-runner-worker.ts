/**
 * 定时序列执行 worker（规划 05 §3）。
 *
 * 职责：
 *   1. 轮询 sequence_steps 中 status='pending' 且 scheduled_at <= now() 的步骤 → 执行（入队 outbox）；
 *   2. 轮询 status='accepted' 的步骤 → 检查 outbox 投递状态，sent 则推进下一步，failed 则 run failed。
 *
 * 多实例防护：pg_try_advisory_lock(hashtext(run_id))，拿不到锁跳过。
 */
import type { Pool, PoolClient } from 'pg';
import { SequenceRepo } from '../repos/sequences.js';
import { executeDueStep, scheduleNextStep, type SequenceRunnerDeps } from '../services/sequence-runner.js';
import type { LoggerLike } from '../services/gateway-client.js';
import { enqueueWebEvent } from '../repos/web-events.js';
import { withNewTrace } from '../services/trace.js';

export class SequenceRunnerWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: SequenceRunnerDeps,
    private readonly intervalMs = 500,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.log.info('sequence-runner: 启动');
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.deps.log.info('sequence-runner: 停止');
  }

  private scheduleNext(delayMs?: number): void {
    if (!this.running) return;
    const delay = delayMs ?? this.intervalMs;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.deps.log.error({ err }, 'sequence-runner: tick 异常');
    } finally {
      this.scheduleNext();
    }
  }

  async runOnce(): Promise<void> {
    await this.processDuePending();
    await this.processAccepted();
  }

  // ---- 1. 到期 pending 步骤 ----

  private async processDuePending(): Promise<void> {
    const due = await this.deps.sequenceRepo.findDuePendingSteps(this.deps.pool);
    for (const step of due) {
      await this.withLock(step.runId, async (client) => {
        // 二次确认状态（避免并发）
        const steps = await this.deps.sequenceRepo.getSteps(client, step.runId);
        const current = steps.find((s) => s.stepIndex === step.stepIndex);
        if (current === undefined || current.status !== 'pending') return;

        await executeDueStep(this.deps, step.runId, step.stepIndex);
      });
    }
  }

  // ---- 2. accepted 步骤的投递状态检查 ----

  private async processAccepted(): Promise<void> {
    const accepted = await this.deps.sequenceRepo.findAcceptedSteps(this.deps.pool);
    for (const step of accepted) {
      await this.withLock(step.runId, async (client) => {
        const steps = await this.deps.sequenceRepo.getSteps(client, step.runId);
        const current = steps.find((s) => s.stepIndex === step.stepIndex);
        if (current === undefined || current.status !== 'accepted') return;

        const run = await this.deps.sequenceRepo.getRun(client, step.runId);
        if (run === undefined) return;
        const sequence = await this.deps.sequenceRepo.getSequence(client, run.sequenceId);
        if (sequence === undefined) return;

        if (step.deliveryStatus === 'sent') {
          // message_sent 已处理 → 标记 sent，排下一步
          // sentAt 从 outbox 获取
          const sentAt = new Date();
          await this.deps.sequenceRepo.markStepSent(client, step.runId, step.stepIndex, sentAt);
          await scheduleNextStep(
            this.deps.sequenceRepo,
            client,
            step.runId,
            run.groupId,
            sequence.steps,
            step.stepIndex,
            sentAt,
          );
          this.deps.log.info({ runId: step.runId, stepIndex: step.stepIndex }, 'sequence: step sent');
        } else if (step.deliveryStatus === 'failed' || step.deliveryStatus === 'cancelled') {
          // 投递失败 → run failed，同事务发 sequence_run 终态事件
          await this.deps.sequenceRepo.markStepFailed(client, step.runId, step.stepIndex);
          await this.deps.sequenceRepo.finishRun(client, step.runId, 'failed');
          await enqueueWebEvent(client, 'sequence_run', {
            runId: step.runId,
            groupId: run.groupId,
            status: 'failed',
            currentStepIndex: step.stepIndex,
          });
          this.deps.log.warn({ runId: step.runId, stepIndex: step.stepIndex }, 'sequence: step failed → run failed');
        }
        // queued / accepted / unknown → 继续等
      });
    }
  }

  // ---- 工具：advisory lock 包裹 ----

  private async withLock(runId: string, fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [runId],
      );
      if (rows[0]?.locked !== true) return;
      try {
        // 每个 run 每步每 tick 一个独立 trace（pending 执行 / accepted 检查通用）
        await withNewTrace(() => fn(client));
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [runId]).catch(() => {});
      }
    } catch (err) {
      this.deps.log.error({ runId, err }, 'sequence-runner: 处理异常');
    } finally {
      client.release();
    }
  }
}

// 重新导出 SequenceRepo 以便 index.ts 构造
export { SequenceRepo };
