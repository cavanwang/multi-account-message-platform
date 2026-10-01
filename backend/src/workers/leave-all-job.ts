/**
 * leave-all job 执行器（B2 群生命周期）。
 *
 * 推进步骤（每次 runOnce 对每个 running leave_all job 推进**一个**步骤）：
 *   1. leave-non-owners  按 accountId 字典序，对非群主成员逐个调 leave
 *   2. leave-owner       所有非群主退完后，群主最后退
 *   3. finish            全部成功 → status='finished'，群 status='left'
 *
 * 失败语义：
 *   - 非群主 leave 业务错误（如 500 INTERNAL_ERROR / 403 SENDER_NOT_IN_GROUP）：
 *     记 errors[]，继续处理其余非群主；群主不退；job 最终 failed。
 *   - 群主 leave 业务错误：记 errors[]，job failed。
 *   - 网络异常（kind='network'，含 503/网络不可达）：不记 errors，下 tick 重试。
 *   - 账号不在群内（SENDER_NOT_IN_GROUP）：视为已退，直接删成员行继续。
 *
 * 崩溃安全：
 *   - 每步先查 DB 成员行再决定动作；已退的成员行已删，跳过（幂等）。
 *   - 多实例防护：pg_try_advisory_lock(hashtext(job_id))，拿不到锁直接跳过。
 */
import type { Pool, PoolClient } from 'pg';
import { JobRepo, type JobRow } from '../repos/jobs.js';
import { GroupRepo } from '../repos/groups.js';
import { AccountRepo } from '../repos/accounts.js';
import type { GroupGateway, LoggerLike } from '../services/gateway-client.js';

export class LeaveAllJobWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly groupGateway: GroupGateway,
    private readonly log: LoggerLike,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info('leave-all-job: 启动');
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log.info('leave-all-job: 停止');
  }

  async runOnce(): Promise<void> {
    const jobRepo = new JobRepo(this.pool);
    const jobs = await jobRepo.listRunnableLeaveAllJobs();
    if (jobs.length === 0) return;

    for (const job of jobs) {
      await this.processJob(job);
    }
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
      this.log.error({ err }, 'leave-all-job: 批处理异常');
    } finally {
      this.scheduleNext();
    }
  }

  // -------------------------------------------------------------------------
  // 单个 job 处理
  // -------------------------------------------------------------------------

  private async processJob(job: JobRow): Promise<void> {
    const client = await this.pool.connect();
    try {
      // ---- 多实例防护：拿到 advisory lock 才处理，拿不到直接跳过 ----
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [job.id],
      );
      if (rows[0]?.locked !== true) {
        this.log.debug({ jobId: job.id }, 'leave-all-job: 未拿到锁，跳过');
        return;
      }

      try {
        await this.stepLeaveNonOwners(client, job);
        await this.stepLeaveOwner(client, job);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [job.id]);
      }
    } catch (err) {
      this.log.error({ jobId: job.id, err }, 'leave-all-job: 处理异常');
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // 步骤 1：非群主成员退群
  // -------------------------------------------------------------------------

  private async stepLeaveNonOwners(client: PoolClient, job: JobRow): Promise<void> {
    if (job.status !== 'running') return;

    const groupRepo = new GroupRepo(this.pool);

    const groupId = job.payload['groupId'] as string;
    const gatewayGroupId = job.payload['gatewayGroupId'] as string;

    const members = await groupRepo.listMembers(groupId);
    const nonOwners = members
      .filter((m) => m.role !== 'creator')
      // 按内部 account_id（UUID）字典序排序，保证同一数据集下顺序稳定
      .sort((a, b) => a.accountId.localeCompare(b.accountId));

    const accountRepo = new AccountRepo(this.pool);

    for (const member of nonOwners) {
      const account = await accountRepo.findByUuid(member.accountId);
      if (account === undefined) {
        // 账号记录缺失（极端情况）：记 errors[]，继续其余成员
        await this.appendError(client, job.id, {
          step: `leave:${member.accountId}`,
          code: 'ACCOUNT_NOT_FOUND',
        });
        continue;
      }

      const result = await this.groupGateway.leaveMember(gatewayGroupId, account.accountId);

      if (result.kind === 'ok') {
        await client.query('BEGIN');
        try {
          await groupRepo.removeMemberByAccountId(client, groupId, member.accountId);
          await client.query('COMMIT');
          this.log.debug(
            { jobId: job.id, accountId: account.accountId },
            'leave-all-job: 非群主退群成功',
          );
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
        continue;
      }

      if (result.kind === 'error') {
        if (result.code === 'SENDER_NOT_IN_GROUP') {
          // 已不在群内（可能之前已成功退但事件未消费），视为成功
          await client.query('BEGIN');
          try {
            await groupRepo.removeMemberByAccountId(client, groupId, member.accountId);
            await client.query('COMMIT');
            this.log.debug(
              { jobId: job.id, accountId: account.accountId },
              'leave-all-job: SENDER_NOT_IN_GROUP，视为已退',
            );
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
          continue;
        }

        // 业务错误（500/403/409 等）：记 errors[]，继续其余成员，群主不退
        this.log.warn(
          { jobId: job.id, accountId: account.accountId, code: result.code },
          'leave-all-job: 非群主退群业务错误',
        );
        await this.appendError(client, job.id, {
          step: `leave:${account.accountId}`,
          code: result.code,
        });
        continue;
      }

      // network：跳过该成员，下 tick 重试
    }
  }

  // -------------------------------------------------------------------------
  // 步骤 2：群主退群（所有非群主退完后）
  // -------------------------------------------------------------------------

  private async stepLeaveOwner(client: PoolClient, job: JobRow): Promise<void> {
    if (job.status !== 'running') return;

    const groupRepo = new GroupRepo(this.pool);
    const jobRepo = new JobRepo(this.pool);

    const groupId = job.payload['groupId'] as string;
    const gatewayGroupId = job.payload['gatewayGroupId'] as string;

    const members = await groupRepo.listMembers(groupId);
    const owner = members.find((m) => m.role === 'creator');
    const nonOwners = members.filter((m) => m.role !== 'creator');

    // 还有非群主成员未退（或已失败），群主不能退
    if (nonOwners.length > 0) {
      // 重新读取最新 errors（本 tick 内 stepLeaveNonOwners 可能刚追加过）
      const fresh = await jobRepo.findById(job.id);
      const errors = fresh?.errors ?? job.errors;
      // 有失败的非群主 → job failed，群主不退
      if (errors.length > 0) {
        await this.failJob(client, job.id, {
          step: 'leave-owner',
          code: 'NON_OWNER_LEAVE_FAILED',
        });
        return;
      }
      // 还有非群主未处理完（network 重试中），等下 tick
      return;
    }

    // 无群主（边界：群只剩非群主时已全部退完，或群本身无群主记录）
    if (owner === undefined) {
      await this.finishJob(client, job, groupId);
      return;
    }

    const accountRepo = new AccountRepo(this.pool);
    const ownerAccount = await accountRepo.findByUuid(owner.accountId);
    if (ownerAccount === undefined) {
      await this.failJob(client, job.id, {
        step: 'leave-owner',
        code: 'ACCOUNT_NOT_FOUND',
      });
      return;
    }

    const result = await this.groupGateway.leaveMember(gatewayGroupId, ownerAccount.accountId);

    if (result.kind === 'ok' || (result.kind === 'error' && result.code === 'SENDER_NOT_IN_GROUP')) {
      // 成功或已不在群内 → 删群主行，群置 left，job finished
      await client.query('BEGIN');
      try {
        await groupRepo.removeMemberByAccountId(client, groupId, owner.accountId);
        await groupRepo.markLeft(client, groupId);
        await jobRepo.markFinished(client, job.id);
        await client.query('COMMIT');
        this.log.info({ jobId: job.id, groupId }, 'leave-all-job: 群主退群成功，job finished');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      return;
    }

    if (result.kind === 'error') {
      this.log.warn(
        { jobId: job.id, accountId: ownerAccount.accountId, code: result.code },
        'leave-all-job: 群主退群业务错误',
      );
      await this.failJob(client, job.id, {
        step: 'leave:owner',
        code: result.code,
      });
      return;
    }

    // network：跳过，下 tick 重试
  }

  // -------------------------------------------------------------------------
  // 工具：完成 job（无成员时直接置 finished）
  // -------------------------------------------------------------------------

  private async finishJob(client: PoolClient, job: JobRow, groupId: string): Promise<void> {
    const jobRepo = new JobRepo(this.pool);
    const groupRepo = new GroupRepo(this.pool);

    await client.query('BEGIN');
    try {
      await groupRepo.markLeft(client, groupId);
      await jobRepo.markFinished(client, job.id);
      await client.query('COMMIT');
      this.log.info({ jobId: job.id, groupId }, 'leave-all-job: 无剩余成员，直接完成');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 工具：追加 error（不置 failed，由后续步骤决定）
  // -------------------------------------------------------------------------

  private async appendError(client: PoolClient, jobId: string, err: { step: string; code: string }): Promise<void> {
    const jobRepo = new JobRepo(this.pool);
    await client.query('BEGIN');
    try {
      await jobRepo.appendError(client, jobId, err);
      await client.query('COMMIT');
      this.log.warn({ jobId, err }, 'leave-all-job: 追加错误');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  }

  // -------------------------------------------------------------------------
  // 工具：记 error 并置 failed
  // -------------------------------------------------------------------------

  private async failJob(client: PoolClient, jobId: string, err: { step: string; code: string }): Promise<void> {
    const jobRepo = new JobRepo(this.pool);
    await client.query('BEGIN');
    try {
      await jobRepo.appendErrorAndFail(client, jobId, err);
      await client.query('COMMIT');
      this.log.warn({ jobId, err }, 'leave-all-job: job failed');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  }
}
