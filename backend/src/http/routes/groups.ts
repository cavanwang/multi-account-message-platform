/**
 * 群相关路由（切片 3 起）：
 *   - POST /api/groups/:id/send  - 出站消息入队
 *
 * 契约（规划 03 §3 / 需求 §5）：
 *   成功：202 { clientMsgId }
 *   失败：400 VALIDATION_ERROR / 404 NOT_FOUND(账号)
 *         409 ACCOUNT_UNAVAILABLE（idle/disconnected/终态）
 *         409 ACCOUNT_NOT_IN_GROUP（账号不在该群；群不存在也归此类）
 *   特例：rate_limited 照常受理，消息保持 queued，限流到期后按原顺序发出。
 *
 * 崩溃安全（INV-1）：clientMsgId 在发网关前生成并随 outbox 行在事务内落库；
 * 本端点只负责"入队"，实际投递由 outbox-sender worker 完成。
 *
 * 可观测性：全链路日志走 request.log（pino 自动携带 reqId，即 trace-id，
 * 客户端可用 x-request-id 头贯穿网关/后端日志）；关键节点输出结构化字段
 * （groupId / accountId / clientMsgId / outboxId），便于按 ID 串联排查。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/env.js';
import { AppError, ErrorCode } from '../errors.js';
import { AccountRepo } from '../../repos/accounts.js';
import { GroupRepo } from '../../repos/groups.js';
import { OutboxRepo } from '../../repos/outbox.js';

interface RouteDeps {
  config: AppConfig;
  pool: Pool;
}

interface GroupParams {
  id: string;
}

interface SendBody {
  accountId?: string;
  text?: string;
}

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
  const outboxRepo = new OutboxRepo(pool);

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
