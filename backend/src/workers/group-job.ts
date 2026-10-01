/**
 * 建群 job 执行器（规划 04 任务 4.3-4.6）。
 *
 * 推进步骤（每次 runOnce 对每个 running job 推进**一个**步骤）：
 *   1. create   网关 createGroup → 事务内写 groups + creator 成员行
 *   2. invite   网关 createInvite → payload 存 inviteLink / inviteReadyAt
 *   3. join     对未 joined 成员发 join；JOIN_TIMEOUT 10s 判 failed
 *   4. promote  全员 joined 后 promote memberAccountIds[0]；NOT_MEMBER_YET 重试 ≤2
 *   5. finish   全部成功 → status='finished'
 *
 * 崩溃安全：
 *   - 每步先查 DB 状态再决定动作；已完成的步骤跳过（幂等）。
 *   - 多实例防护：pg_try_advisory_lock(hashtext(job_id))，拿不到锁直接跳过。
 *   - 网络/503 异常不记 errors，下 tick 重试。
 *
 * JOIN_TIMEOUT（10s）判定：
 *   join_requested_at < now() - 10s 且 joined_at IS NULL → 追加 error → job failed。
 *
 * promote 上限：
 *   group_job_members.promote_calls 硬上限 2；超过 → 记 errors → job failed。
 */
import type { Pool, PoolClient } from 'pg';
import { JobRepo, type JobRow } from '../repos/jobs.js';
import { GroupRepo } from '../repos/groups.js';
import { AccountRepo } from '../repos/accounts.js';
import type { GroupGateway, LoggerLike } from '../services/gateway-client.js';
import { withNewTrace } from '../services/trace.js';

/** payload 中已持久化的邀请信息。 */
interface InvitePayload {
  readonly inviteLink?: string;
  readonly inviteReadyAt?: string;
}

const JOIN_TIMEOUT_MS = 10_000;
const MAX_PROMOTE_CALLS = 2;

export class GroupJobWorker {
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
    this.log.info('group-job: 启动');
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log.info('group-job: 停止');
  }

  async runOnce(): Promise<void> {
    const jobRepo = new JobRepo(this.pool);
    const jobs = await jobRepo.listRunnableCreateGroupJobs();
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
      this.log.error({ err }, 'group-job: 批处理异常');
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
        this.log.debug({ jobId: job.id }, 'group-job: 未拿到锁，跳过');
        return;
      }

      try {
        // 一次 tick 推进一个 job 的各步骤：同一 traceId 覆盖本轮全部
        // 网关往返与事务日志（下一 tick 重新开启新 trace）
        await withNewTrace(async () => {
          await this.stepCreate(client, job);
          await this.stepInvite(client, job);
          await this.stepJoin(client, job);
          await this.stepPromote(client, job);
        });
      } finally {
        // advisory lock 随事务/连接释放
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [job.id]);
      }
    } catch (err) {
      this.log.error({ jobId: job.id, err }, 'group-job: 处理异常');
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // 步骤 1：create
  // -------------------------------------------------------------------------

  private async stepCreate(client: PoolClient, job: JobRow): Promise<void> {
    if (job.status !== 'running') return;

    const groupRepo = new GroupRepo(this.pool);
    const existing = await groupRepo.findByJobId(job.id, client);
    if (existing !== undefined) {
      // 已建群，跳过
      return;
    }

    const creatorAccountId = job.payload['creatorAccountId'] as string;
    const accountRepo = new AccountRepo(this.pool);
    const creator = await accountRepo.findByAccountId(creatorAccountId);
    if (creator?.platformUserId == null) {
      await this.failJob(client, job.id, { step: 'create', code: 'CREATOR_NOT_ONLINE' });
      return;
    }

    const result = await this.groupGateway.createGroup(creatorAccountId);
    if (result.kind !== 'ok') {
      if (result.kind === 'network') {
        // 网络异常不记 errors，下 tick 重试
        return;
      }
      await this.failJob(client, job.id, { step: 'create', code: result.code });
      return;
    }

    const gatewayGroupId = result.data.groupId;
    await client.query('BEGIN');
    try {
      await groupRepo.insertGroup(client, {
        gatewayGroupId,
        creatorAccountId: creator.id,
        creatorPlatformUserId: creator.platformUserId,
        jobId: job.id,
      });
      await client.query('COMMIT');
      this.log.info({ jobId: job.id, gatewayGroupId }, 'group-job: create 完成');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 步骤 2：invite
  // -------------------------------------------------------------------------

  private async stepInvite(client: PoolClient, job: JobRow): Promise<void> {
    if (job.status !== 'running') return;

    const groupRepo = new GroupRepo(this.pool);
    const group = await groupRepo.findByJobId(job.id, client);
    if (group === undefined) return;

    const payload = job.payload as InvitePayload;
    if (payload.inviteLink !== undefined) {
      // 已有链接，跳过（inviteReadyAt 已持久化）
      return;
    }

    const result = await this.groupGateway.createInvite(group.gatewayGroupId);
    if (result.kind !== 'ok') {
      if (result.kind === 'network') return;
      await this.failJob(client, job.id, { step: 'invite', code: result.code });
      return;
    }

    const inviteReadyAt = new Date(Date.now() + result.data.readyAfterMs);
    await client.query('BEGIN');
    try {
      const jobRepo = new JobRepo(this.pool);
      await jobRepo.updateInvitePayload(client, job.id, {
        inviteLink: result.data.inviteLink,
        inviteReadyAt,
      });
      await client.query('COMMIT');
      this.log.info({ jobId: job.id, inviteReadyAt }, 'group-job: invite 完成');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 步骤 3：join
  // -------------------------------------------------------------------------

  private async stepJoin(client: PoolClient, job: JobRow): Promise<void> {
    if (job.status !== 'running') return;

    const groupRepo = new GroupRepo(this.pool);
    const group = await groupRepo.findByJobId(job.id, client);
    if (group === undefined) return;

    const payload = job.payload as InvitePayload;
    const jobRepo = new JobRepo(this.pool);
    const members = await jobRepo.listJobMembers(job.id);

    // 链接已清除（INVITE_EXPIRED）→ 重置 join_requested_at，等下 tick 用新链接重新 join
    if (payload.inviteLink === undefined) {
      const needReset = members.filter((m) => m.joinRequestedAt !== null && m.joinedAt === null);
      if (needReset.length > 0) {
        await client.query('BEGIN');
        try {
          for (const m of needReset) {
            await client.query(
              `UPDATE group_job_members
               SET join_requested_at = NULL
               WHERE job_id = $1 AND account_id = $2 AND joined_at IS NULL`,
              [job.id, m.accountId],
            );
          }
          await client.query('COMMIT');
          this.log.debug({ jobId: job.id, count: needReset.length }, 'group-job: 链接已清除，重置 join_requested_at');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
      return;
    }

    if (payload.inviteReadyAt === undefined) {
      // 还没到 invite 步骤
      return;
    }

    // 等 invite ready
    if (new Date(payload.inviteReadyAt) > new Date()) {
      return;
    }

    const accountRepo = new AccountRepo(this.pool);
    const readyAtMs = new Date(payload.inviteReadyAt).getTime();

    for (const member of members) {
      if (member.joinedAt !== null) continue;

      // JOIN_TIMEOUT 判定（最高优先级）
      if (
        member.joinRequestedAt !== null &&
        Date.now() - member.joinRequestedAt.getTime() > JOIN_TIMEOUT_MS
      ) {
        await this.failJob(client, job.id, {
          step: `join:${member.accountId}`,
          code: 'JOIN_TIMEOUT',
        });
        return;
      }

      // 链接重新申请后，把 inviteReadyAt 之前用旧链接发的 join_requested_at 重置
      // （INVITE_EXPIRED 场景：旧链接 join 受理过，新链接 ready 后需要重新 join）
      if (
        member.joinRequestedAt !== null &&
        member.joinRequestedAt.getTime() < readyAtMs
      ) {
        await client.query('BEGIN');
        try {
          await client.query(
            `UPDATE group_job_members
             SET join_requested_at = NULL
             WHERE job_id = $1 AND account_id = $2 AND joined_at IS NULL`,
            [job.id, member.accountId],
          );
          await client.query('COMMIT');
          this.log.debug({ jobId: job.id, accountId: member.accountId }, 'group-job: 重置过期链接的 join_requested_at');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
        // 本成员重置后下 tick 再 join
        continue;
      }

      // 已发过 join 请求但还没超时，等下 tick
      if (member.joinRequestedAt !== null) continue;

      const account = await accountRepo.findByUuid(member.accountId);
      if (account === undefined) {
        await this.failJob(client, job.id, {
          step: `join:${member.accountId}`,
          code: 'ACCOUNT_NOT_FOUND',
        });
        return;
      }

      const result = await this.groupGateway.join(
        group.gatewayGroupId,
        account.accountId,
        payload.inviteLink,
      );

      if (result.kind === 'ok') {
        await client.query('BEGIN');
        try {
          await jobRepo.markJoinRequested(client, job.id, member.accountId);
          await client.query('COMMIT');
          this.log.debug(
            { jobId: job.id, accountId: member.accountId },
            'group-job: join 已受理',
          );
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
        continue;
      }

      if (result.kind === 'error') {
        this.log.info({ jobId: job.id, code: result.code, accountId: account.accountId }, 'group-job: join 业务错误');
        if (result.code === 'ALREADY_MEMBER') {
          // 已在群内，直接视为 joined
          await client.query('BEGIN');
          try {
            await jobRepo.markJoined(client, job.id, member.accountId);
            await client.query('COMMIT');
            this.log.debug(
              { jobId: job.id, accountId: member.accountId },
              'group-job: ALREADY_MEMBER 直通',
            );
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
          continue;
        }

        if (result.code === 'INVITE_NOT_READY') {
          // 链接还没 ready，下 tick 再试
          continue;
        }

        if (result.code === 'INVITE_EXPIRED') {
          // 重新申请链接，下 tick 用新链接重试
          await client.query('BEGIN');
          try {
            await jobRepo.clearInvitePayload(client, job.id);
            await client.query('COMMIT');
            this.log.info({ jobId: job.id }, 'group-job: INVITE_EXPIRED，清除旧链接');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
          return;
        }

        // 其他业务错误 → failed
        await this.failJob(client, job.id, {
          step: `join:${member.accountId}`,
          code: result.code,
        });
        return;
      }

      // network：跳过该成员，下 tick 重试
    }
  }

  // -------------------------------------------------------------------------
  // 步骤 4：promote
  // -------------------------------------------------------------------------

  private async stepPromote(client: PoolClient, job: JobRow): Promise<void> {
    if (job.status !== 'running') return;

    const groupRepo = new GroupRepo(this.pool);
    const group = await groupRepo.findByJobId(job.id, client);
    if (group === undefined) return;

    const jobRepo = new JobRepo(this.pool);
    const members = await jobRepo.listJobMembers(job.id);

    // 全员 joined 才允许 promote
    if (members.some((m) => m.joinedAt === null)) return;

    const memberAccountIds = job.payload['memberAccountIds'] as string[];
    if (memberAccountIds.length === 0) {
      // 无成员（边界：成员列表为空，直接 finish）
      await client.query('BEGIN');
      try {
        await jobRepo.markFinished(client, job.id);
        await client.query('COMMIT');
        this.log.info({ jobId: job.id }, 'group-job: 无成员，直接完成');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      return;
    }

    const targetAccountId = memberAccountIds[0]!;
    const accountRepo = new AccountRepo(this.pool);
    const target = await accountRepo.findByAccountId(targetAccountId);
    if (target === undefined) {
      await this.failJob(client, job.id, { step: 'promote', code: 'ACCOUNT_NOT_FOUND' });
      return;
    }

    // 找到对应的 group_job_members 行
    const targetMember = members.find((m) => m.accountId === target.id);
    if (targetMember === undefined) {
      await this.failJob(client, job.id, { step: 'promote', code: 'MEMBER_NOT_FOUND' });
      return;
    }

    // promote 调用次数上限检查
    if (targetMember.promoteCalls >= MAX_PROMOTE_CALLS) {
      await this.failJob(client, job.id, { step: 'promote', code: 'NOT_MEMBER_YET' });
      return;
    }

    const creatorAccountId = job.payload['creatorAccountId'] as string;
    const result = await this.groupGateway.promote(
      group.gatewayGroupId,
      creatorAccountId,
      targetAccountId,
    );

    if (result.kind === 'ok') {
      // promote 成功 → job finished
      await client.query('BEGIN');
      try {
        await jobRepo.markFinished(client, job.id);
        await client.query('COMMIT');
        this.log.info({ jobId: job.id }, 'group-job: promote 完成，job finished');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      return;
    }

    if (result.kind === 'error' && result.code === 'NOT_MEMBER_YET') {
      const newCount = await client.query<{ promote_calls: number }>(
        `UPDATE group_job_members
         SET promote_calls = promote_calls + 1
         WHERE job_id = $1 AND account_id = $2
         RETURNING promote_calls`,
        [job.id, targetMember.accountId],
      );
      const calls = newCount.rows[0]?.promote_calls ?? 0;

      if (calls >= MAX_PROMOTE_CALLS) {
        await this.failJob(client, job.id, { step: 'promote', code: 'NOT_MEMBER_YET' });
      } else {
        this.log.debug(
          { jobId: job.id, accountId: targetAccountId, calls },
          'group-job: NOT_MEMBER_YET，下 tick 重试',
        );
      }
      return;
    }

    if (result.kind === 'network') {
      // 网络异常不记 errors，下 tick 重试
      return;
    }

    // 其他业务错误 → failed
    await this.failJob(client, job.id, { step: 'promote', code: result.code });
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
      this.log.warn({ jobId, err }, 'group-job: job failed');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  }
}