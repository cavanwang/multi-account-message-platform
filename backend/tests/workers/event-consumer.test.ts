/**
 * EventConsumer 测试（规划 03 任务 3.8–3.10，INV-4 / INV-5）。
 *
 * 覆盖：
 *  - message_sent 回填 outbox（sent + gateway_msg_id）+ messages 行（is_own=true）
 *  - 自身消息回流：message_sent 与 message 事件写同一行（一条消息只有一行）
 *  - 重复 eventId 去重（ingestFrame ON CONFLICT DO NOTHING，S2）
 *  - 乱序 sentAt upsert：后处理的事件覆盖先处理的（最后写入者胜）
 *  - member_joined / member_left：成员增删
 *  - handler 失败：attempts+1 + last_error + inconsistency web_event，processed_at 保持 NULL
 *
 * 测试不启动 SSE loop，直接往 events_inbox 插行后调 runOnce() 驱动消费。
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventsInboxRepo } from '../../src/repos/events-inbox.js';
import { EventConsumer } from '../../src/workers/event-consumer.js';
import type { LoggerLike } from '../../src/services/gateway-client.js';
import {
  insertOutbox,
  pool,
  queryMany,
  queryOne,
  resetDb,
  seedGroupWithMember,
  withTx,
} from '../helpers/db.js';

const silentLog: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 消费用 worker：gatewayUrl 不会被用到（不启动 SSE）。 */
function makeConsumer(): EventConsumer {
  return new EventConsumer(pool, 'http://unused', silentLog, { batchSize: 50 });
}

/** 直接往 inbox 插一行（模拟 SSE ingest 已落库）。 */
async function insertInbox(
  eventId: number,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'INSERT INTO events_inbox (event_id, type, payload) VALUES ($1, $2, $3::jsonb)',
    [eventId, type, JSON.stringify(payload)],
  );
}

describe('EventConsumer', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('message_sent 回填 outbox sent + gateway_msg_id，并写入 messages 行（is_own=true）', async () => {
    const { accountUuid, groupId } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid, { status: 'accepted' });

    const sentAt = '2026-01-01T00:00:01.000Z';
    await insertInbox(1, 'message_sent', { clientMsgId, msgId: 'gw-msg-1', sentAt });

    const consumer = makeConsumer();
    expect(await consumer.runOnce()).toBe(1);

    // outbox → sent，回填 gateway_msg_id 与 sent_at
    const outbox = await queryOne<{
      delivery_status: string;
      gateway_msg_id: string | null;
      sent_at: Date | null;
    }>('SELECT delivery_status, gateway_msg_id, sent_at FROM outbox_messages WHERE client_msg_id = $1', [clientMsgId]);
    expect(outbox?.delivery_status).toBe('sent');
    expect(outbox?.gateway_msg_id).toBe('gw-msg-1');
    expect(outbox?.sent_at?.toISOString()).toBe(sentAt);

    // messages 行：is_own=true，text 来自 outbox
    const msg = await queryOne<{ is_own: boolean; text: string; client_msg_id: string | null }>(
      'SELECT is_own, text, client_msg_id FROM messages WHERE group_id = $1 AND msg_id = $2',
      [groupId, 'gw-msg-1'],
    );
    expect(msg?.is_own).toBe(true);
    expect(msg?.client_msg_id).toBe(clientMsgId);

    // inbox 行已置 processed_at
    const inbox = await queryOne<{ processed_at: Date | null }>(
      'SELECT processed_at FROM events_inbox WHERE event_id = 1',
    );
    expect(inbox?.processed_at).not.toBeNull();

    // web_event message_sent 已入队（INV-5：与业务事务同提交）
    const events = await queryMany<{ type: string }>(
      "SELECT type FROM web_events WHERE type = 'message_sent'",
    );
    expect(events.length).toBe(1);
  });

  it('自身消息回流：message_sent 与 message 事件写同一行（一条消息只有一行）', async () => {
    const { accountUuid, groupId, gatewayGroupId } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid, { status: 'accepted' });

    const sentAt = '2026-01-01T00:00:02.000Z';
    // 先 message_sent，再回流 message（senderPlatformUserId 命中本群成员 → isOwn）
    await insertInbox(1, 'message_sent', { clientMsgId, msgId: 'gw-msg-2', sentAt });
    await insertInbox(2, 'message', {
      groupId: gatewayGroupId,
      msgId: 'gw-msg-2',
      senderPlatformUserId: 'pu_acct-1',
      text: 'hello world',
      sentAt,
    });

    const consumer = makeConsumer();
    expect(await consumer.runOnce()).toBe(2);

    const rows = await queryMany<{ is_own: boolean; text: string; sender_platform_user_id: string }>(
      'SELECT is_own, text, sender_platform_user_id FROM messages WHERE group_id = $1 AND msg_id = $2',
      [groupId, 'gw-msg-2'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.is_own).toBe(true);
    expect(rows[0]?.text).toBe('hello world');
    expect(rows[0]?.sender_platform_user_id).toBe('pu_acct-1');
  });

  it('重复 eventId 去重：ingestFrame 第二次返回 false，inbox 只有一行', async () => {
    const repo = new EventsInboxRepo(pool);

    const first = await withTx(async (client) =>
      repo.ingestFrame(client, { eventId: 42, type: 'message', payload: { x: 1 } }),
    );
    const second = await withTx(async (client) =>
      repo.ingestFrame(client, { eventId: 42, type: 'message', payload: { x: 1 } }),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);

    const rows = await queryMany<{ event_id: string }>(
      'SELECT event_id FROM events_inbox WHERE event_id = 42',
    );
    expect(rows.length).toBe(1);

    // 游标已推进
    expect(await repo.getCursor()).toBe(42);
  });

  it('乱序 sentAt：后处理的事件覆盖先处理的（upsert 最后写入者胜，不丢弃旧时间戳）', async () => {
    const { groupId, gatewayGroupId } = await seedGroupWithMember('acct-1');

    // 同一 (groupId,msgId) 两个事件：第一个 sentAt 较新，第二个较旧
    // 消费按 event_id 顺序 → 最终行应为第二个事件的值（补投语义：任意早的 sentAt 都接受）
    await insertInbox(1, 'message', {
      groupId: gatewayGroupId,
      msgId: 'gw-msg-3',
      senderPlatformUserId: 'external-user',
      text: 'newer text',
      sentAt: '2026-01-02T00:00:00.000Z',
    });
    await insertInbox(2, 'message', {
      groupId: gatewayGroupId,
      msgId: 'gw-msg-3',
      senderPlatformUserId: 'external-user',
      text: 'older text',
      sentAt: '2026-01-01T00:00:00.000Z',
    });

    const consumer = makeConsumer();
    expect(await consumer.runOnce()).toBe(2);

    const msg = await queryOne<{ text: string; sent_at: Date; is_own: boolean }>(
      'SELECT text, sent_at, is_own FROM messages WHERE group_id = $1 AND msg_id = $2',
      [groupId, 'gw-msg-3'],
    );
    expect(msg?.text).toBe('older text');
    expect(msg?.sent_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(msg?.is_own).toBe(false); // 外部用户
  });

  it('member_joined / member_left：服务账号成员增删', async () => {
    // acct-2 在线且有 platform_user_id，但不是目标群成员
    const { accountUuid } = await seedGroupWithMember('acct-2');
    void accountUuid;

    // 另建一个群（acct-1 创建），acct-2 不在其中
    const gatewayGroupId = `grp_${randomUUID()}`;
    const creator = await queryOne<{ id: string }>(
      "SELECT id FROM accounts WHERE account_id = 'acct-1'",
    );
    const group = await queryOne<{ id: string }>(
      'INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ($1, $2) RETURNING id',
      [gatewayGroupId, creator?.id ?? ''],
    );
    expect(group?.id).toBeDefined();

    await insertInbox(1, 'member_joined', { groupId: gatewayGroupId, platformUserId: 'pu_acct-2' });
    await insertInbox(2, 'member_left', { groupId: gatewayGroupId, platformUserId: 'pu_acct-2' });

    // 先消费 member_joined
    const consumer = makeConsumer();
    expect(await consumer.runOnce()).toBe(2);

    // 两条都消费完后，成员记录应已被 member_left 删除
    const member = await queryOne<{ platform_user_id: string }>(
      'SELECT platform_user_id FROM group_members WHERE group_id = $1 AND platform_user_id = $2',
      [group?.id ?? '', 'pu_acct-2'],
    );
    expect(member).toBeUndefined();
  });

  it('handler 失败：attempts+1 + last_error + inconsistency web_event，processed_at 保持 NULL', async () => {
    // message 事件指向不存在的群 → handler 抛错
    await insertInbox(1, 'message', {
      groupId: 'grp_not_exist',
      msgId: 'gw-msg-x',
      senderPlatformUserId: 'someone',
      text: 'boom',
      sentAt: '2026-01-01T00:00:00.000Z',
    });

    const consumer = makeConsumer();
    expect(await consumer.runOnce()).toBe(1);

    const inbox = await queryOne<{
      processed_at: Date | null;
      attempts: number;
      last_error: string | null;
    }>('SELECT processed_at, attempts, last_error FROM events_inbox WHERE event_id = 1');
    expect(inbox?.processed_at).toBeNull();
    expect(inbox?.attempts).toBe(1);
    expect(inbox?.last_error).toContain('群不存在');

    // inconsistency web_event 已入队
    const events = await queryMany<{ payload: { kind: string; eventId: number; type: string } }>(
      "SELECT payload FROM web_events WHERE type = 'inconsistency'",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.payload.kind).toBe('event_handler');
    expect(events[0]?.payload.eventId).toBe(1);
    expect(events[0]?.payload.type).toBe('message');

    // 下轮 runOnce 会重试（INV-4 不丢）：attempts → 2
    expect(await consumer.runOnce()).toBe(1);
    const retried = await queryOne<{ attempts: number }>(
      'SELECT attempts FROM events_inbox WHERE event_id = 1',
    );
    expect(retried?.attempts).toBe(2);
  });
});
