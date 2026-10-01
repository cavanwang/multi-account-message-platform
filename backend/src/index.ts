/**
 * 进程入口。
 *
 * 启动顺序（任一环节失败都以非 0 退出码终止）：
 *   1. 解析并校验环境变量
 *   2. 校验数据库 schema 版本 —— **落后于代码时拒绝启动**（需求 A0）
 *   3. 创建连接池、组装 Fastify、监听端口
 *
 * 注意：migration 的**执行**由 compose 启动命令负责（`migrate-cli up`），
 * 本入口只做**校验**。这样应用代码永远不需要写 DDL，也不需要 DDL 权限。
 */
import { loadConfig, type AppConfig } from './config/env.js';
import { closePool, getPool } from './db/pool.js';
import { assertSchemaUpToDate, SchemaVersionError } from './db/migrate.js';
import { buildServer } from './http/server.js';
import { RateLimitSweeper } from './workers/rate-limit-sweeper.js';
import { OutboxSender } from './workers/outbox-sender.js';
import { Reconcile504Worker } from './workers/reconcile-504.js';
import { EventConsumer } from './workers/event-consumer.js';
import { HttpSendGateway, HttpQueryGateway, HttpGroupGateway } from './services/gateway-client.js';
import { GroupJobWorker } from './workers/group-job.js';
import { WsHub } from './services/ws-hub.js';
import { WsPublisher } from './workers/ws-publisher.js';
import { AgentClient } from './services/agent-client.js';
import { AgentRunRepo } from './repos/agent-runs.js';
import { GroupRepo } from './repos/groups.js';
import { OutboxRepo } from './repos/outbox.js';
import { AccountRepo } from './repos/accounts.js';
import { AgentRunnerWorker } from './workers/agent-runner-worker.js';

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    // 用 console 而非 logger：logger 依赖 config，此时还没有
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // schema 校验：不通过则明确拒绝启动
  try {
    const version = await assertSchemaUpToDate(config.databaseUrl);
    console.log(`[startup] schema 版本校验通过：${version}`);
  } catch (err) {
    if (err instanceof SchemaVersionError) {
      console.error(`[startup] 拒绝启动：${err.message}`);
    } else {
      console.error(
        '[startup] 无法连接数据库或校验 schema：',
        err instanceof Error ? err.message : err,
      );
    }
    process.exit(1);
  }

  const pool = getPool(config.databaseUrl);

  // WebSocket 连接中心：被 WS 路由（登记连接）与 WsPublisher（广播）共享
  const wsHub = new WsHub();

  // 后台 worker：限流到期自动恢复 online（崩溃安全，1s 周期扫描 DB）
  const rateLimitSweeper = new RateLimitSweeper(pool);
  rateLimitSweeper.start();

  const app = await buildServer({ config, pool, hub: wsHub });

  // 后台 worker：出站发送（claim → 发网关 → 按错误码收敛状态）
  // 日志复用 fastify 根 logger 的 child，带 worker 名便于过滤追踪
  const gatewaySender = new HttpSendGateway(
    config.gatewayUrl,
    app.log.child({ component: 'gateway-send' }),
  );
  const outboxSender = new OutboxSender(
    pool,
    gatewaySender,
    app.log.child({ worker: 'outbox-sender' }),
    { batchSize: 10, intervalMs: 1000, backoffBaseMs: 2000, maxBackoffMs: 30_000 },
  );
  outboxSender.start();

  // 后台 worker：504 收敛（by-client-id 查询 → 定态或重发一次）
  const queryGateway = new HttpQueryGateway(
    config.gatewayUrl,
    app.log.child({ component: 'gateway-query' }),
  );
  const reconcileWorker = new Reconcile504Worker(
    pool,
    queryGateway,
    gatewaySender,
    app.log.child({ worker: 'reconcile-504' }),
    { batchSize: 10, intervalMs: 1000, backoffBaseMs: 500, maxBackoffMs: 5000, maxAttempts: 20 },
  );
  reconcileWorker.start();

  // 后台 worker：事件消费（SSE 事件入 inbox + 幂等消费，INV-4）
  const eventConsumer = new EventConsumer(
    pool,
    config.gatewayUrl,
    app.log.child({ worker: 'event-consumer' }),
    { batchSize: 50, intervalMs: 200, reconnectBaseMs: 500, reconnectMaxMs: 5000 },
  );
  eventConsumer.start();

  // 后台 worker：建群 job 执行器（create → invite → join → promote）
  const groupGateway = new HttpGroupGateway(
    config.gatewayUrl,
    app.log.child({ component: 'gateway-group' }),
  );
  const groupJobWorker = new GroupJobWorker(
    pool,
    groupGateway,
    app.log.child({ worker: 'group-job' }),
    1000,
  );
  groupJobWorker.start();

  // 后台 worker：WebSocket 事件推送（轮询 web_events → WsHub 广播）
  const wsPublisher = new WsPublisher(pool, wsHub, { intervalMs: 500, batchSize: 100 });
  await wsPublisher.start();

  // 后台 worker：Agent Run 执行器（轮询 running runs → runAgent）
  const agentClient = new AgentClient(
    config.agentUrl,
    app.log.child({ component: 'agent-client' }),
  );
  const agentRunnerWorker = new AgentRunnerWorker(
    {
      pool,
      agentRunRepo: new AgentRunRepo(pool),
      groupRepo: new GroupRepo(pool),
      outboxRepo: new OutboxRepo(pool),
      accountRepo: new AccountRepo(pool),
      agentClient,
      groupGateway,
      log: app.log.child({ worker: 'agent-runner' }),
    },
    { intervalMs: 200 },
  );
  agentRunnerWorker.start();

  // --- 优雅退出 ---
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, '收到退出信号，开始关闭');
    try {
      rateLimitSweeper.stop();
      outboxSender.stop();
      reconcileWorker.stop();
      eventConsumer.stop();
      groupJobWorker.stop();
      wsPublisher.stop();
      agentRunnerWorker.stop();
      await app.close();
      await closePool();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '关闭过程出错');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, '监听端口失败');
    await closePool();
    process.exit(1);
  }
}

void main();
