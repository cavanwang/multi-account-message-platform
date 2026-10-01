/**
 * 群相关路由：
 *   - POST /api/groups           - 建群 job 受理（切片 4，规划 04 §2 / 契约 §5）
 *   - POST /api/groups/:id/send  - 出站消息入队（切片 3）
 *
 * POST /api/groups 契约：
 *   成功：202 { jobId }（job 已落库，由 worker 异步执行建群全流程）
 *   失败：400 VALIDATION_ERROR（字段缺失/空成员/含群主/重复成员）
 *         422 ACCOUNT_NOT_ONLINE（任一账号不存在或非 online）
 *
 * 崩溃安全：job 与 group_job_members 在**同一事务**落库后才返回 202——
 * 响应发出则 job 一定存在，worker（切片 4 批次 2）重启后可凭 payload 续跑。
 *
 * POST /api/groups/:id/send 契约（规划 03 §3 / 需求 §5）：
 *   成功：202 { clientMsgId }
 *   失败：400 VALIDATION_ERROR / 404 NOT_FOUND(账号)
 *         409 ACCOUNT_UNAVAILABLE（idle/disconnected/终态）
 *         409 ACCOUNT_NOT_IN_GROUP（账号不在该群；群不存在也归此类）
 *   特例：rate_limited 照常受理，消息保持 queued，限流到期后按原顺序发出。
 *
 * 崩溃安全（INV-1）：clientMsgId 在发网关前生成并随 outbox 行在事务内落库；
 * send 端点只负责"入队"，实际投递由 outbox-sender worker 完成。
 *
 * 可观测性：全链路日志走 request.log（pino 自动携带 reqId，即 trace-id，
 * 客户端可用 x-request-id 头贯穿网关/后端日志）；关键节点输出结构化字段
 * （groupId / accountId / clientMsgId / outboxId / jobId），便于按 ID 串联排查。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/env.js';
import { AppError, ErrorCode } from '../errors.js';
import { AccountRepo } from '../../repos/accounts.js';
import { GroupRepo } from '../../repos/groups.js';
import { JobRepo } from '../../repos/jobs.js';
import { OutboxRepo } from '../../repos/outbox.js';

interface RouteDeps {
  config: AppConfig;
  pool: Pool;
}

interface GroupParams {
  id: string;
}

interface CreateGroupBody {
  creatorAccountId?: unknown;
  memberAccountIds?: unknown;
}

interface SendBody {
  accountId?: string;
  text?: string;
}

/**
 * 建群成员数上限。题面群规模很小，此上限用于防御异常大请求
 * （无上限时 N 个成员 = N 行插入，恶意请求可放大 DB 压力）。
 */
const MAX_GROUP_MEMBERS = 100;

/** groups.id 是 UUID；提前校验格式，避免非法值打到数据库报 22P02。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function registerGroupRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { pool } = deps;
  const accountRepo = new AccountRepo(pool);
  const groupRepo = new GroupRepo(pool);
  const jobRepo = new JobRepo(pool);
  const outboxRepo = new OutboxRepo(pool);

  // POST /api/groups - 建群 job 受理（同步校验 + 事务落库 + 202；worker 异步执行）
  app.post<{ Body: CreateGroupBody }>(
    '/api/groups',
    async (request: FastifyRequest<{ Body: CreateGroupBody }>, reply) => {
      const body = request.body ?? {};
      const log = request.log;

      // ---- 1) 字段形状校验（400）----
      const { creatorAccountId, memberAccountIds } = body;
      if (typeof creatorAccountId !== 'string' || creatorAccountId.trim() === '') {
        throw AppError.badRequest('缺少必填字段: creatorAccountId');
      }
      if (!Array.isArray(memberAccountIds) || memberAccountIds.length === 0) {
        throw AppError.badRequest('memberAccountIds 必须是非空数组（至少 1 个成员）');
      }
      if (memberAccountIds.length > MAX_GROUP_MEMBERS) {
        throw AppError.badRequest(
          `memberAccountIds 超过上限 ${MAX_GROUP_MEMBERS}（当前 ${memberAccountIds.length}）`,
        );
      }
      for (const id of memberAccountIds) {
        // id !== id.trim() 的项（带空白）直接 400：否则会查不到账号而被误报为 422
        if (typeof id !== 'string' || id === '' || id !== id.trim()) {
          throw AppError.badRequest('memberAccountIds 的每一项必须是不带空白的非空字符串');
        }
      }
      // 群主不能出现在成员列表（契约：memberAccountIds 不含群主）
      if (memberAccountIds.includes(creatorAccountId)) {
        throw AppError.badRequest('memberAccountIds 不能包含群主 creatorAccountId');
      }
      // 重复成员会导致 group_job_members PK 冲突，提前拒绝
      if (new Set(memberAccountIds).size !== memberAccountIds.length) {
        throw AppError.badRequest('memberAccountIds 存在重复成员');
      }

      log.info(
        { creatorAccountId, memberCount: memberAccountIds.length },
        'create-group: 收到建群请求',
      );

      // ---- 2) 账号存在性与 online 校验（422）----
      // 契约只定义了 400/422 两种失败：账号不存在按"不在线"归入 ACCOUNT_NOT_ONLINE。
      // 批量一次查询（避免 N+1 往返），再按请求顺序逐个判定，保证报错顺序稳定。
      const allIds = [creatorAccountId, ...(memberAccountIds as string[])];
      const found = await accountRepo.findByAccountIds(allIds);
      const byAccountId = new Map(found.map((a) => [a.accountId, a]));

      const creator = byAccountId.get(creatorAccountId);
      if (creator === undefined || creator.status !== 'online') {
        log.warn(
          { creatorAccountId, status: creator?.status ?? null },
          'create-group: 群主不在线（或不存在），拒绝受理',
        );
        throw new AppError(422, ErrorCode.ACCOUNT_NOT_ONLINE, `群主 ${creatorAccountId} 不在线`, {
          accountId: creatorAccountId,
          status: creator?.status ?? null,
        });
      }

      // 按请求顺序归并成员（memberAccountIds[0] 之后会被 promote 为 admin）
      const memberUuids: string[] = [];
      for (const memberAccountId of memberAccountIds as string[]) {
        const member = byAccountId.get(memberAccountId);
        if (member === undefined || member.status !== 'online') {
          log.warn(
            { memberAccountId, status: member?.status ?? null },
            'create-group: 成员不在线（或不存在），拒绝受理',
          );
          throw new AppError(
            422,
            ErrorCode.ACCOUNT_NOT_ONLINE,
            `成员 ${memberAccountId} 不在线`,
            { accountId: memberAccountId, status: member?.status ?? null },
          );
        }
        memberUuids.push(member.id);
      }

      // ---- 3) 事务内落 job + 成员名单（与 202 原子生效）----
      // payload 存文本 accountId（与 API 契约一致），worker 重启后据此恢复执行。
      const payload = {
        creatorAccountId,
        memberAccountIds: memberAccountIds as string[],
      };
      const client = await pool.connect();
      let jobId: string;
      try {
        await client.query('BEGIN');
        jobId = await jobRepo.createCreateGroupJob(client, {
          creatorAccountUuid: creator.id,
          memberAccountUuids: memberUuids,
          payload,
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ creatorAccountId, err }, 'create-group: job 落库事务失败，已回滚');
        throw err;
      } finally {
        client.release();
      }

      log.info({ jobId, creatorAccountId, memberCount: memberUuids.length }, 'create-group: job 已受理');
      reply.status(202);
      return { jobId };
    },
  );

  // POST /api/groups/:id/send - 出站消息入队（先落库，worker 异步投递）
  app.post<{ Params: GroupParams; Body: SendBody }>(
    '/api/groups/:id/send',
    async (
      request: FastifyRequest<{ Params: GroupParams; Body: SendBody }>,
      reply,
    ) => {
      const { id: groupId } = request.params;
      const body = request.body ?? {};
      const log = request.log; // 自动携带 reqId（trace-id）

      // ---- 1) 参数校验 ----
      if (!UUID_RE.test(groupId)) {
        throw AppError.badRequest(`路径参数 id 必须是 UUID，当前为 "${groupId}"`);
      }
      if (typeof body.accountId !== 'string' || body.accountId.trim() === '') {
        throw AppError.badRequest('缺少必填字段: accountId');
      }
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        throw AppError.badRequest('缺少必填字段: text（不能为空）');
      }
      const accountId = body.accountId;
      const text = body.text;

      log.info(
        { groupId, accountId, textLength: text.length },
        'send: 收到出站消息请求',
      );

      // ---- 2) 账号存在性 ----
      const account = await accountRepo.findByAccountId(accountId);
      if (account === undefined) {
        log.warn({ groupId, accountId }, 'send: 账号不存在，拒绝入队');
        throw AppError.notFound(`账号 ${accountId} 不存在`);
      }

      // ---- 3) 账号可用性：仅 online / rate_limited 可受理 ----
      // rate_limited 照常受理（保持 queued，到期按序发出）；idle/disconnected/终态拒绝
      if (account.status !== 'online' && account.status !== 'rate_limited') {
        log.warn(
          { groupId, accountId, accountStatus: account.status },
          'send: 账号当前状态不可用，拒绝入队',
        );
        throw AppError.conflict(
          ErrorCode.ACCOUNT_UNAVAILABLE,
          `账号 ${accountId} 当前状态为 ${account.status}，不可用于发送`,
          { accountStatus: account.status },
        );
      }

      // ---- 4) 成员校验：账号必须在该群（群不存在时 isMember 亦为 false） ----
      const isMember = await groupRepo.isMember(groupId, account.id);
      if (!isMember) {
        log.warn(
          { groupId, accountId, accountUuid: account.id },
          'send: 账号不在该群（或群不存在），拒绝入队',
        );
        throw AppError.conflict(
          ErrorCode.ACCOUNT_NOT_IN_GROUP,
          `账号 ${accountId} 不在群 ${groupId} 中`,
        );
      }

      // ---- 5) 事务内入队（INV-1：先落库；发网关由 worker 负责） ----
      const clientMsgId = randomUUID();
      const client = await pool.connect();
      let outboxId: string;
      try {
        await client.query('BEGIN');
        const row = await outboxRepo.enqueue(client, {
          groupId,
          accountId: account.id,
          clientMsgId,
          text,
          origin: 'api',
        });
        outboxId = row.id;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        log.error(
          { groupId, accountId, clientMsgId, err },
          'send: outbox 入队事务失败，已回滚',
        );
        throw err;
      } finally {
        client.release();
      }

      log.info(
        {
          groupId,
          accountId,
          accountStatus: account.status,
          clientMsgId,
          outboxId,
          // rate_limited 受理是契约特例，显式标记便于排障时解释"为何一直没发出"
          deferredByRateLimit: account.status === 'rate_limited',
        },
        'send: 已入队 queued，等待 worker 投递',
      );

      reply.status(202);
      return { clientMsgId };
    },
  );
}
