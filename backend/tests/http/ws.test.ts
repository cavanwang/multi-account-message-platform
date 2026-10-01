/**
 * WebSocket 路由与推送测试（切片 4，规划 04 任务 4.12 / 4.13 / 4.15）。
 *
 * 覆盖：
 *  - 未发 auth：不收任何事件
 *  - 无效 token：auth success:false + 连接关闭
 *  - 有效 token：auth success:true + 收到已入队的 web_events（补发）
 *  - sinceSeq 补发：只发 seq > sinceSeq 的事件
 *  - seq 严格单调递增
 *  - WsPublisher：轮询 web_events → broadcast → 更新游标
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/auth/tokens.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildServer } from '../../src/http/server.js';
import { WsHub } from '../../src/services/ws-hub.js';
import { WsPublisher } from '../../src/workers/ws-publisher.js';
import { pool, resetDb } from '../helpers/db.js';

let app: FastifyInstance;
let hub: WsHub;
let adminToken: string;
let config: AppConfig;

beforeAll(async () => {
  config = loadConfig({
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test',
    GATEWAY_URL: 'http://127.0.0.1:1',
    AGENT_URL: 'http://127.0.0.1:1',
    JWT_SECRET: 'test-secret-test-secret',
    LOG_LEVEL: 'fatal',
  });
  hub = new WsHub();
  app = await buildServer({ config, pool, hub });
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

/** 往 web_events 表直接插入若干事件，返回它们的 seq（转成 number）。 */
async function seedWebEvents(count: number, startFrom = 0): Promise<number[]> {
  const seqs: number[] = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await pool.query<{ seq: string }>(
      `INSERT INTO web_events (type, payload)
       VALUES ($1, $2::jsonb) RETURNING seq`,
      [`test_event`, JSON.stringify({ i: startFrom + i })],
    );
    seqs.push(Number(rows[0]!.seq));
  }
  return seqs;
}

/** 辅助：连接 WS，发送 auth 帧，收集所有收到的消息直到超时。 */
async function connectAndAuth(
  token: string,
  sinceSeq?: number,
  timeoutMs = 300,
): Promise<{ frames: unknown[]; closed: boolean }> {
  const ws = (await app.injectWS('/ws')) as WebSocket;
  const frames: unknown[] = [];
  let closed = false;

  const done = new Promise<void>((resolve) => {
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString('utf8')));
    });
    ws.on('close', () => {
      closed = true;
      resolve();
    });
    // 超时结束收集
    setTimeout(resolve, timeoutMs);
  });

  const authFrame: Record<string, unknown> = { type: 'auth', accessToken: token };
  if (sinceSeq !== undefined) authFrame['sinceSeq'] = sinceSeq;
  ws.send(JSON.stringify(authFrame));

  await done;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  return { frames, closed };
}

describe('WebSocket auth 握手', () => {
  it('首帧非 auth → auth 失败 + 关闭', async () => {
    const ws = (await app.injectWS('/ws')) as WebSocket;
    const frames: unknown[] = [];
    let closed = false;
    const done = new Promise<void>((resolve) => {
      ws.on('message', (data) => frames.push(JSON.parse(data.toString('utf8'))));
      ws.on('close', () => {
        closed = true;
        resolve();
      });
      setTimeout(resolve, 300);
    });
    ws.send(JSON.stringify({ type: 'hello' }));
    await done;

    expect(frames).toHaveLength(1);
    const f = frames[0] as { type: string; success: boolean };
    expect(f.type).toBe('auth');
    expect(f.success).toBe(false);
    expect(closed).toBe(true);
  });

  it('无效 token → auth 失败 + 关闭', async () => {
    const { frames, closed } = await connectAndAuth('invalid-token');
    expect(frames).toHaveLength(1);
    const f = frames[0] as { type: string; success: boolean };
    expect(f.type).toBe('auth');
    expect(f.success).toBe(false);
    expect(closed).toBe(true);
  });

  it('有效 token → auth 成功 + 收到已入队事件', async () => {
    await seedWebEvents(2);
    const { frames } = await connectAndAuth(adminToken, undefined, 400);

    // 第一帧是 auth success
    expect(frames[0]).toEqual({ type: 'auth', success: true });
    // 后续是 web_events 补发帧
    const eventFrames = frames.slice(1) as Array<{ seq: number; type: string }>;
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);
    // seq 单调递增
    for (let i = 1; i < eventFrames.length; i++) {
      expect(eventFrames[i]!.seq).toBeGreaterThan(eventFrames[i - 1]!.seq);
    }
  });

  it('sinceSeq 补发：只发 seq > sinceSeq 的事件', async () => {
    const seqs = await seedWebEvents(3);
    // 以第 1 条的 seq 为 sinceSeq，应只收到第 2、3 条
    const { frames } = await connectAndAuth(adminToken, seqs[0], 400);
    const eventFrames = frames.slice(1) as Array<{ seq: number }>;
    const receivedSeqs = eventFrames.map((f) => f.seq);
    expect(receivedSeqs).not.toContain(seqs[0]);
    expect(receivedSeqs).toContain(seqs[1]);
    expect(receivedSeqs).toContain(seqs[2]);
  });
});

describe('WsPublisher worker', () => {
  it('轮询 web_events 并通过 hub 广播，更新游标', async () => {
    const testHub = new WsHub();
    const publisher = new WsPublisher(pool, testHub, { intervalMs: 50, batchSize: 10 });

    // 模拟一个已连接的客户端，收集广播帧
    const broadcastFrames: Array<{ seq: number; type: string }> = [];
    const fakeSocket = {
      readyState: 1, // OPEN
      OPEN: 1,
      send: (msg: string) => broadcastFrames.push(JSON.parse(msg)),
      once: () => fakeSocket,
      on: () => fakeSocket,
    } as unknown as WebSocket;
    testHub.add(fakeSocket);

    const seqs = await seedWebEvents(3);

    await publisher.start();
    // 等待 publisher 至少推送一轮
    await new Promise((r) => setTimeout(r, 200));
    publisher.stop();

    // 3 条事件都被广播
    const broadcastSeqs = broadcastFrames.map((f) => f.seq);
    for (const s of seqs) {
      expect(broadcastSeqs).toContain(s);
    }

    // 游标已更新到最大 seq
    const { rows } = await pool.query<{ last_pushed_seq: string }>(
      'SELECT last_pushed_seq FROM ws_push_cursor WHERE id = 1',
    );
    expect(Number(rows[0]!.last_pushed_seq)).toBe(seqs[seqs.length - 1]);
  });
});
