/**
 * Reconcile504Worker 测试（规划 03 任务 3.6 + 3.11）。
 *
 * 覆盖：
 *  - 200 found → accepted + gateway_msg_id 回填 + 任务删除
 *  - 404 + 未重发过 → prepareResend 落库 → 重发成功 → accepted
 *  - 404 + 未重发过 → 重发失败 → failed(NETWORK_TIMEOUT)
 *  - 404 + 已重发过 → 直接 failed，不发第二次
 *  - 503 → 保持 unknown，attempts+1，due_at 推后
 *  - 行已定态（sent/failed）→ 清理任务，无操作
 *  - attempts 超限 → 兜底判 failed
 *
 * 网关用假实现，无需真实容器。
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { QueryGateway, SendGateway, SendResult, ByClientIdResult } from '../../src/services/gateway-client.js';
import type { LoggerLike } from '../../src/services/gateway-client.js';
import { Reconcile504Worker } from '../../src/workers/reconcile-504.js';
import { insertOutbox, pool, queryOne, resetDb, seedGroupWithMember } from '../helpers/db.js';

const silentLog: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeQueryGateway implements QueryGateway {
  results: ByClientIdResult[] = [];
  calls: Array<{ gatewayGroupId: string; clientMsgId: string }> = [];
  defaultResult: ByClientIdResult = { kind: 'notFound' };

  push(...r: ByClientIdResult[]): this {
    this.results.push(...r);
    return this;
  }

  async byClientId(gatewayGroupId: string, clientMsgId: string): Promise<ByClientIdResult> {
    this.calls.push({ gatewayGroupId, clientMsgId });
    return this.results.shift() ?? this.defaultResult;
  }
}

class FakeSendGateway implements SendGateway {
  results: SendResult[] = [];
  calls: Array<{ groupId: string; accountId: string; clientMsgId: string; text: string }> = [];
  defaultResult: SendResult = { kind: 'accepted' };

  push(...r: SendResult[]): this {
    this.results.push(...r);
    return this;
  }

  async send(groupId: string, accountId: string, clientMsgId: string, text: string): Promise<SendResult> {
    this.calls.push({ groupId, accountId, clientMsgId, text });
    return this.results.shift() ?? this.defaultResult;
  }
}

async function insertReconTask(
  outboxId: string,
  opts: { attempts?: number; dueAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO pending_reconciliations (id, outbox_id, kind, due_at, attempts)
     VALUES ($1, $2, 'resolve_504', $3, $4)`,
    [id, outboxId, opts.dueAt ?? new Date(Date.now() - 1000), opts.attempts ?? 0],
  );
  return id;
}

function makeWorker(query: QueryGateway, send: SendGateway, opts = {}): Reconcile504Worker {
  return new Reconcile504Worker(pool, query, send, silentLog, opts);
}

describe('Reconcile504Worker', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('200 found → accepted + gateway_msg_id 回填 + 任务删除', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id: outboxId } = await insertOutbox(groupId, accountUuid, { status: 'unknown' });
    const taskId = await insertReconTask(outboxId);
    const query = new FakeQueryGateway().push({ kind: 'found', msgId: 'g-msg-123', sentAt: new Date().toISOString() });
    const send = new FakeSendGateway();

    await makeWorker(query, send).runOnce();

    const row = await queryOne<{ delivery_status: string; gateway_msg_id: string }>(
      'SELECT delivery_status, gateway_msg_id FROM outbox_messages WHERE id = $1',
      [outboxId],
    );
    expect(row!.delivery_status).toBe('accepted');
    expect(row!.gateway_msg_id).toBe('g-msg-123');

    const task = await queryOne('SELECT id FROM pending_reconciliations WHERE id = $1', [taskId]);
    expect(task).toBeUndefined();
  });

  it('404 + 未重发过 → 重发成功 → accepted，resend_count=1，generation+1', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id: outboxId, clientMsgId } = await insertOutbox(groupId, accountUuid, { status: 'unknown' });
    await insertReconTask(outboxId);
    const query = new FakeQueryGateway().push({ kind: 'notFound' });
    const send = new FakeSendGateway(); // 默认 accepted

    await makeWorker(query, send).runOnce();

    // 重发用了同一个 clientMsgId
    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]!.clientMsgId).toBe(clientMsgId);

    const row = await queryOne<{ delivery_status: string; resend_count: number; generation: number }>(
      'SELECT delivery_status, resend_count, generation FROM outbox_messages WHERE id = $1',
      [outboxId],
    );
    expect(row!.delivery_status).toBe('accepted');
    expect(row!.resend_count).toBe(1);
    expect(row!.generation).toBe(1);

    const task = await queryOne('SELECT id FROM pending_reconciliations WHERE outbox_id = $1', [outboxId]);
    expect(task).toBeUndefined();
  });

  it('404 + 未重发过 → 重发失败 → failed(NETWORK_TIMEOUT)', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id: outboxId } = await insertOutbox(groupId, accountUuid, { status: 'unknown' });
    await insertReconTask(outboxId);
    const query = new FakeQueryGateway().push({ kind: 'notFound' });
    const send = new FakeSendGateway().push({ kind: 'error', status: 503, code: 'SERVICE_UNAVAILABLE', extra: {} });

    await makeWorker(query, send).runOnce();

    const row = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE id = $1',
      [outboxId],
    );
    expect(row!.delivery_status).toBe('failed');
    expect(row!.fail_code).toBe('NETWORK_TIMEOUT');

    const task = await queryOne('SELECT id FROM pending_reconciliations WHERE outbox_id = $1', [outboxId]);
    expect(task).toBeUndefined();
  });

  it('404 + 已重发过 → 直接 failed，不再发 HTTP', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id: outboxId } = await insertOutbox(groupId, accountUuid, { status: 'unknown' });
    // 预置已重发过
    await pool.query('UPDATE outbox_messages SET resend_count = 1 WHERE id = $1', [outboxId]);
    await insertReconTask(outboxId);
    const query = new FakeQueryGateway().push({ kind: 'notFound' });
    const send = new FakeSendGateway();

    await makeWorker(query, send).runOnce();

    // 不应调 send
    expect(send.calls).toHaveLength(0);

    const row = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE id = $1',
      [outboxId],
    );
    expect(row!.delivery_status).toBe('failed');
    expect(row!.fail_code).toBe('NETWORK_TIMEOUT');
  });

  it('503 → 保持 unknown，attempts+1，due_at 推后', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id: outboxId } = await insertOutbox(groupId, accountUuid, { status: 'unknown' });
    const taskId = await insertReconTask(outboxId, { attempts: 0 });
    const query = new FakeQueryGateway().push({ kind: 'unavailable' });
    const send = new FakeSendGateway();

    await makeWorker(query, send).runOnce();

    // 状态不变
    const row = await queryOne<{ delivery_status: string }>(
      'SELECT delivery_status FROM outbox_messages WHERE id = $1',
      [outboxId],
    );
    expect(row!.delivery_status).toBe('unknown');

    // 任务 attempts+1，due_at 推后
    const task = await queryOne<{ attempts: number; due_at: Date }>(
      'SELECT attempts, due_at FROM pending_reconciliations WHERE id = $1',
      [taskId],
    );
    expect(task!.attempts).toBe(1);
    expect(task!.due_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('行已定态（sent）→ 清理任务，无操作', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id: outboxId } = await insertOutbox(groupId, accountUuid, { status: 'sent' });
    const taskId = await insertReconTask(outboxId);
    const query = new FakeQueryGateway();
    const send = new FakeSendGateway();

    await makeWorker(query, send).runOnce();

    // 任务被清理
    const task = await queryOne('SELECT id FROM pending_reconciliations WHERE id = $1', [taskId]);
    expect(task).toBeUndefined();
    // 状态未被改
    const row = await queryOne<{ delivery_status: string }>(
      'SELECT delivery_status FROM outbox_messages WHERE id = $1',
      [outboxId],
    );
    expect(row!.delivery_status).toBe('sent');
  });

  it('attempts 超限 → 兜底判 failed，任务删除', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    const { id: outboxId } = await insertOutbox(groupId, accountUuid, { status: 'unknown' });
    const taskId = await insertReconTask(outboxId, { attempts: 20 });
    const query = new FakeQueryGateway();
    const send = new FakeSendGateway();

    await makeWorker(query, send, { maxAttempts: 20 }).runOnce();

    const row = await queryOne<{ delivery_status: string; fail_code: string }>(
      'SELECT delivery_status, fail_code FROM outbox_messages WHERE id = $1',
      [outboxId],
    );
    expect(row!.delivery_status).toBe('failed');
    expect(row!.fail_code).toBe('NETWORK_TIMEOUT');

    const task = await queryOne('SELECT id FROM pending_reconciliations WHERE id = $1', [taskId]);
    expect(task).toBeUndefined();
  });
});
