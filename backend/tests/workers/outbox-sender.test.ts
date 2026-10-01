/**
 * OutboxSender worker 集成测试（规划 03 任务 3.4 + 3.5 + 部分 3.6/3.7）。
 *
 * 覆盖：
 *  - 202 → accepted，写 accepted_at + web_event
 *  - 429 → 账号进 rate_limited（带 until），行保持 queued，批内跳过同账号剩余行
 *  - 403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED → 终态原子事务，行被置 cancelled
 *  - 403 GROUP_WRITE_FORBIDDEN → 群 unreachable + 停序列 + 行 failed（原子事务）
 *  - 403 SENDER_NOT_IN_GROUP / 409 ACCOUNT_OFFLINE → 行 failed
 *  - 504 NETWORK_TIMEOUT → 行 unknown + pending_reconciliations 创建
 *  - 503 / 网络异常 → 不改状态，退避，本批中断
 *  - FIFO 顺序：按 created_at 逐条发
 *  - CAS 冲突：并发取消后发响应 → 静默跳过不崩溃
 *
 * 网关用 FakeGateway（内存可编程），无需起真实容器。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SendGateway, SendResult } from '../../src/services/gateway-client.js';
import type { LoggerLike } from '../../src/services/gateway-client.js';
import { OutboxSender } from '../../src/workers/outbox-sender.js';
import { insertOutbox, pool, queryOne, resetDb, seedGroupWithMember } from '../helpers/db.js';

// 静默日志：测试不输出
const silentLog: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 可编程假网关：按队列顺序返回结果，记录所有调用。 */
class FakeGateway implements SendGateway {
  readonly calls: Array<{ groupId: string; accountId: string; clientMsgId: string; text: string }> = [];
  private script: SendResult[] = [];
  /** 默认返回（队列空时）。 */
  defaultResult: SendResult = { kind: 'accepted' };
  /** send 内回调：用于模拟并发干扰（如外部取消该行）。 */
  onSend?: (clientMsgId: string) => Promise<void>;

  push(...results: SendResult[]): this {
    this.script.push(...results);
    return this;
  }

  async send(
    groupId: string,
    accountId: string,
    clientMsgId: string,
    text: string,
  ): Promise<SendResult> {
    this.calls.push({ groupId, accountId, clientMsgId, text });
    if (this.onSend !== undefined) await this.onSend(clientMsgId);
    return this.script.shift() ?? this.defaultResult;
  }
}

function makeSender(gateway: SendGateway): OutboxSender {
  return new OutboxSender(pool, gateway, silentLog, { batchSize: 10 });
}

describe('OutboxSender', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('202 → accepted：写 accepted_at + message_accepted 事件', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid);
    const gateway = new FakeGateway();

    await makeSender(gateway).runOnce();

    expect(gateway.calls).toHaveLength(1);
    const row = await queryOne<{ delivery_status: string; accepted_at: Date | null }>(
      'SELECT delivery_status, accepted_at FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row!.delivery_status).toBe('accepted');
    expect(row!.accepted_at).not.toBeNull();

    const evt = await queryOne<{ type: string }>(
      "SELECT type FROM web_events WHERE type = 'message_accepted'",
    );
    expect(evt).toBeDefined();
  });

  it('429 → 账号进 rate_limited，行保持 queued，批内跳过同账号剩余行', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    await insertOutbox(groupId, accountUuid); // 第一条会吃到 429
    await insertOutbox(groupId, accountUuid); // 同账号第二条应被批内跳过
    const gateway = new FakeGateway().push({
      kind: 'error',
      status: 429,
      code: 'RATE_LIMITED',
      extra: { retryAfterSeconds: 120 },
    });

    await makeSender(gateway).runOnce();

    // 只发了一次（第二条被跳过）
    expect(gateway.calls).toHaveLength(1);

    // 账号已限流
    const account = await queryOne<{ status: string; rate_limited_until: Date | null }>(
      'SELECT status, rate_limited_until FROM accounts WHERE account_id = $1',
      ['acct-1'],
    );
    expect(account!.status).toBe('rate_limited');
    expect(account!.rate_limited_until).not.toBeNull();

    // 两条消息都还是 queued
    const rows = await queryOne<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM outbox_messages WHERE delivery_status = 'queued'",
    );
    expect(Number(rows!.cnt)).toBe(2);
  });

  it('403 ACCOUNT_SUSPENDED → 账号进终态 suspended，行被终态事务取消', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid);
    const gateway = new FakeGateway().push({
      kind: 'error',
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
      extra: {},
    });

    await makeSender(gateway).runOnce();

    const account = await queryOne<{ status: string }>(
      'SELECT status FROM accounts WHERE account_id = $1',
      ['acct-1'],
    );
    expect(account!.status).toBe('suspended');

    const row = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row!.delivery_status).toBe('cancelled');
    expect(row!.fail_code).toBe('ACCOUNT_TERMINAL');
  });

  it('401 SESSION_EXPIRED → 账号进终态 session_expired，行被取消', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid);
    const gateway = new FakeGateway().push({
      kind: 'error',
      status: 401,
      code: 'SESSION_EXPIRED',
      extra: {},
    });

    await makeSender(gateway).runOnce();

    const account = await queryOne<{ status: string }>(
      'SELECT status FROM accounts WHERE account_id = $1',
      ['acct-1'],
    );
    expect(account!.status).toBe('session_expired');

    const row = await queryOne<{ delivery_status: string }>(
      'SELECT delivery_status FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row!.delivery_status).toBe('cancelled');
  });

  it('403 GROUP_WRITE_FORBIDDEN → 群 unreachable + 停序列 + 行 failed（原子事务）', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    // 造一个 running 序列
    await pool.query(
      `INSERT INTO sequence_runs (group_id, status) VALUES ($1, 'running')`,
      [groupId],
    );
    const { clientMsgId } = await insertOutbox(groupId, accountUuid);
    const gateway = new FakeGateway().push({
      kind: 'error',
      status: 403,
      code: 'GROUP_WRITE_FORBIDDEN',
      extra: {},
    });

    await makeSender(gateway).runOnce();

    const group = await queryOne<{ status: string }>(
      'SELECT status FROM groups WHERE id = $1',
      [groupId],
    );
    expect(group!.status).toBe('unreachable');

    const run = await queryOne<{ status: string }>(
      'SELECT status FROM sequence_runs WHERE group_id = $1',
      [groupId],
    );
    expect(run!.status).toBe('stopped');

    const row = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row!.delivery_status).toBe('failed');
    expect(row!.fail_code).toBe('GROUP_WRITE_FORBIDDEN');
  });

  it('403 SENDER_NOT_IN_GROUP / 409 ACCOUNT_OFFLINE → 行 failed，账号/群不动', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { clientMsgId: c1 } = await insertOutbox(groupId, accountUuid);
    const { clientMsgId: c2 } = await insertOutbox(groupId, accountUuid);
    const gateway = new FakeGateway().push(
      { kind: 'error', status: 403, code: 'SENDER_NOT_IN_GROUP', extra: {} },
      { kind: 'error', status: 409, code: 'ACCOUNT_OFFLINE', extra: {} },
    );

    await makeSender(gateway).runOnce();

    const r1 = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE client_msg_id = $1',
      [c1],
    );
    expect(r1!.delivery_status).toBe('failed');
    expect(r1!.fail_code).toBe('SENDER_NOT_IN_GROUP');

    const r2 = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE client_msg_id = $1',
      [c2],
    );
    expect(r2!.delivery_status).toBe('failed');
    expect(r2!.fail_code).toBe('ACCOUNT_OFFLINE');

    // 账号仍是 online，群仍是 active
    const account = await queryOne<{ status: string }>(
      'SELECT status FROM accounts WHERE account_id = $1',
      ['acct-1'],
    );
    expect(account!.status).toBe('online');
    const group = await queryOne<{ status: string }>(
      'SELECT status FROM groups WHERE id = $1',
      [groupId],
    );
    expect(group!.status).toBe('active');
  });

  it('504 NETWORK_TIMEOUT → 行 unknown + 创建 pending_reconciliations（同一事务）', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid);
    const gateway = new FakeGateway().push({
      kind: 'error',
      status: 504,
      code: 'NETWORK_TIMEOUT',
      extra: {},
    });

    await makeSender(gateway).runOnce();

    const row = await queryOne<{ delivery_status: string }>(
      'SELECT delivery_status FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row!.delivery_status).toBe('unknown');

    const recon = await queryOne<{ kind: string; due_at: Date }>(
      `SELECT kind, due_at FROM pending_reconciliations
       WHERE outbox_id = (SELECT id FROM outbox_messages WHERE client_msg_id = $1)`,
      [clientMsgId],
    );
    expect(recon).toBeDefined();
    expect(recon!.kind).toBe('resolve_504');
    // 到期时间在 2s 左右（允许少量执行耗时）
    const diffMs = recon!.due_at.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(1000);
    expect(diffMs).toBeLessThanOrEqual(2000);
  });

  it('503 / 网络异常 → 不改状态，中断本批，进入退避', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    await insertOutbox(groupId, accountUuid); // 第一条吃 503
    await insertOutbox(groupId, accountUuid); // 第二条不应被发
    const gateway = new FakeGateway().push({
      kind: 'error',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      extra: {},
    });

    await makeSender(gateway).runOnce();

    // 只发了一次就中断
    expect(gateway.calls).toHaveLength(1);

    // 两条都保持 queued
    const rows = await queryOne<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM outbox_messages WHERE delivery_status = 'queued'",
    );
    expect(Number(rows!.cnt)).toBe(2);
  });

  it('FIFO 顺序：按 created_at 逐条发网关', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const t = Date.now();
    await insertOutbox(groupId, accountUuid, { createdAt: new Date(t - 2000) });
    await insertOutbox(groupId, accountUuid, { createdAt: new Date(t - 1000) });
    await insertOutbox(groupId, accountUuid, { createdAt: new Date(t) });
    const gateway = new FakeGateway(); // 默认全 accepted

    await makeSender(gateway).runOnce();

    expect(gateway.calls).toHaveLength(3);
    // 用 clientMsgId 反查 created_at，验证发送顺序严格按 created_at 升序
    const cmids = gateway.calls.map((c) => c.clientMsgId);
    const { rows } = await pool.query<{ client_msg_id: string; created_at: Date }>(
      'SELECT client_msg_id, created_at FROM outbox_messages WHERE client_msg_id = ANY($1)',
      [cmids],
    );
    const orderMap = new Map(rows.map((r) => [r.client_msg_id, r.created_at.getTime()]));
    const times = cmids.map((id) => orderMap.get(id)!);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('CAS 冲突：响应到达前行被并发取消 → 静默跳过不崩溃', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { clientMsgId } = await insertOutbox(groupId, accountUuid);
    const gateway = new FakeGateway();
    // 模拟：send 已发出，但响应返回前，外部把行取消（如并发终态事务）
    gateway.onSend = async (cmid) => {
      await pool.query(
        `UPDATE outbox_messages
         SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL',
             version = version + 1, updated_at = now()
         WHERE client_msg_id = $1`,
        [cmid],
      );
    };

    // 不应抛异常
    await makeSender(gateway).runOnce();

    // 行保持 cancelled（不被覆盖回 accepted）
    const row = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE client_msg_id = $1',
      [clientMsgId],
    );
    expect(row!.delivery_status).toBe('cancelled');
    expect(row!.fail_code).toBe('ACCOUNT_TERMINAL');
  });
});
