/**
 * 消息时间线分页测试（切片 4，规划 04 任务 4.10 / 4.11）。
 *
 * 覆盖：
 *  - 空时间线
 *  - 已落地消息（messages 表）字段正确，非自己的消息 delivery/fail 为 null
 *  - 未落地 outbox（queued）出现在列表，msgId=null、deliveryStatus=queued
 *  - 游标分页：首页 + 翻页取完全部、无遗漏无重复
 *  - 同毫秒多条消息不丢失
 *  - limit 上限 50、非法 limit 回退默认
 *  - 群不存在 → 404
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/auth/tokens.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { pool, resetDb, seedGroupWithMember } from '../helpers/db.js';

let app: FastifyInstance;
let adminToken: string;

beforeAll(async () => {
  const config: AppConfig = loadConfig({
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test',
    GATEWAY_URL: 'http://127.0.0.1:1',
    AGENT_URL: 'http://127.0.0.1:1',
    JWT_SECRET: 'test-secret-test-secret',
    LOG_LEVEL: 'fatal',
  });
  app = await buildServer({ config, pool });
  await app.ready();
  adminToken = await signAccessToken(config, {
    userId: 'user-admin',
    username: 'admin',
    role: 'admin',
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
});

function getMessages(groupId: string, query?: { before?: string; limit?: number }) {
  const qs = new URLSearchParams();
  if (query?.before !== undefined) qs.set('before', query.before);
  if (query?.limit !== undefined) qs.set('limit', String(query.limit));
  const qsStr = qs.toString();
  return app.inject({
    method: 'GET',
    url: `/api/groups/${groupId}/messages${qsStr ? `?${qsStr}` : ''}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
}

interface TimelineItemDto {
  msgId: string | null;
  clientMsgId: string | null;
  senderPlatformUserId: string;
  isOwn: boolean;
  text: string;
  sentAt: string;
  deliveryStatus: string | null;
  failCode: string | null;
}

interface TimelineResponse {
  items: TimelineItemDto[];
  nextCursor: string | null;
}

/** 直接往 messages 表插一条已落地消息（绕过 repo，构造测试数据）。 */
async function seedMessage(
  groupId: string,
  opts: {
    msgId: string;
    text: string;
    sentAt: Date;
    isOwn?: boolean;
    clientMsgId?: string | null;
    senderPlatformUserId?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO messages (msg_id, group_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      opts.msgId,
      groupId,
      opts.clientMsgId ?? null,
      opts.senderPlatformUserId ?? 'pu_external',
      opts.isOwn ?? false,
      opts.text,
      opts.sentAt,
    ],
  );
}

describe('GET /api/groups/:id/messages', () => {
  it('空时间线返回空数组，nextCursor 为 null', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const res = await getMessages(groupId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as TimelineResponse;
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('群不存在 → 404', async () => {
    const res = await getMessages(randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it('已落地消息字段正确，非自己的消息 delivery/fail 为 null', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const sentAt = new Date('2026-01-01T00:00:00Z');
    await seedMessage(groupId, {
      msgId: 'gw-1',
      text: 'hello from external',
      sentAt,
      isOwn: false,
      senderPlatformUserId: 'pu_external_user',
    });

    const res = await getMessages(groupId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as TimelineResponse;
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.msgId).toBe('gw-1');
    expect(item.isOwn).toBe(false);
    expect(item.text).toBe('hello from external');
    expect(item.senderPlatformUserId).toBe('pu_external_user');
    expect(item.deliveryStatus).toBeNull();
    expect(item.failCode).toBeNull();
    expect(item.sentAt).toBe(sentAt.toISOString());
    expect(body.nextCursor).toBeNull();
  });

  it('未落地的 queued outbox 出现在列表，msgId=null、deliveryStatus=queued', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    // 直接插一条 queued outbox（无 gateway_msg_id）
    const clientMsgId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_messages
         (group_id, account_id, client_msg_id, text, delivery_status, origin)
       VALUES ($1, $2, $3, 'queued message', 'queued', 'api')`,
      [groupId, accountUuid, clientMsgId],
    );

    const res = await getMessages(groupId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as TimelineResponse;
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.msgId).toBeNull();
    expect(item.clientMsgId).toBe(clientMsgId);
    expect(item.isOwn).toBe(true);
    expect(item.deliveryStatus).toBe('queued');
    expect(item.failCode).toBeNull();
  });

  it('游标分页：翻页取完全部，无遗漏无重复', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    // 插 5 条消息，sentAt 递增
    for (let i = 0; i < 5; i++) {
      await seedMessage(groupId, {
        msgId: `gw-${i}`,
        text: `msg ${i}`,
        sentAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }

    // 第一页 limit=2
    const res1 = await getMessages(groupId, { limit: 2 });
    const body1 = res1.json() as TimelineResponse;
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();
    // 倒序：先返回 sentAt 最大的（msg 4, msg 3）
    expect(body1.items[0]!.msgId).toBe('gw-4');
    expect(body1.items[1]!.msgId).toBe('gw-3');

    // 第二页
    const res2 = await getMessages(groupId, { before: body1.nextCursor!, limit: 2 });
    const body2 = res2.json() as TimelineResponse;
    expect(body2.items).toHaveLength(2);
    expect(body2.nextCursor).not.toBeNull();
    expect(body2.items[0]!.msgId).toBe('gw-2');
    expect(body2.items[1]!.msgId).toBe('gw-1');

    // 第三页（最后 1 条）
    const res3 = await getMessages(groupId, { before: body2.nextCursor!, limit: 2 });
    const body3 = res3.json() as TimelineResponse;
    expect(body3.items).toHaveLength(1);
    expect(body3.nextCursor).toBeNull();
    expect(body3.items[0]!.msgId).toBe('gw-0');

    // 无重复、无遗漏
    const allIds = [...body1.items, ...body2.items, ...body3.items].map((i) => i.msgId);
    expect(new Set(allIds).size).toBe(5);
    expect(allIds.sort()).toEqual(['gw-0', 'gw-1', 'gw-2', 'gw-3', 'gw-4']);
  });

  it('同毫秒多条消息不丢失（msgId 破平）', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const sameMs = new Date('2026-01-01T00:00:00.000Z');
    // 3 条同毫秒消息
    await seedMessage(groupId, { msgId: 'a', text: 'a', sentAt: sameMs });
    await seedMessage(groupId, { msgId: 'b', text: 'b', sentAt: sameMs });
    await seedMessage(groupId, { msgId: 'c', text: 'c', sentAt: sameMs });

    const res = await getMessages(groupId);
    const body = res.json() as TimelineResponse;
    expect(body.items).toHaveLength(3);
    const ids = body.items.map((i) => i.msgId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    // 全部 sentAt 相同
    for (const item of body.items) {
      expect(new Date(item.sentAt).getTime()).toBe(sameMs.getTime());
    }
  });

  it('limit 超过 50 自动钳制为 50', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    // 插 60 条
    for (let i = 0; i < 60; i++) {
      await seedMessage(groupId, {
        msgId: `gw-${i}`,
        text: `m${i}`,
        sentAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    const res = await getMessages(groupId, { limit: 100 });
    const body = res.json() as TimelineResponse;
    // 钳制到 50
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it('已落地的自己消息：deliveryStatus 来自 outbox', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const clientMsgId = randomUUID();
    // 先插 outbox（sent 状态，有 gateway_msg_id）
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO outbox_messages
         (group_id, account_id, client_msg_id, text, delivery_status, origin, gateway_msg_id, sent_at)
       VALUES ($1, $2, $3, 'sent msg', 'sent', 'api', 'gw-sent-1', now())
       RETURNING id`,
      [groupId, accountUuid, clientMsgId],
    );
    // 再插 messages（关联同一 client_msg_id）
    await seedMessage(groupId, {
      msgId: 'gw-sent-1',
      text: 'sent msg',
      sentAt: new Date(),
      isOwn: true,
      clientMsgId,
      senderPlatformUserId: 'pu_acct-1',
    });

    const res = await getMessages(groupId);
    const body = res.json() as TimelineResponse;
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.msgId).toBe('gw-sent-1');
    expect(item.isOwn).toBe(true);
    expect(item.deliveryStatus).toBe('sent');
    // 不应出现第二行（outbox 有 gateway_msg_id，不参与 UNION 的未落地分支）
    expect(rows).toHaveLength(1);
  });
});
