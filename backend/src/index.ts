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
  const app = await buildServer({ config, pool });

  // --- 优雅退出 ---
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, '收到退出信号，开始关闭');
    try {
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
