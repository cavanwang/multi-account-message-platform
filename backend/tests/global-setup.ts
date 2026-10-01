/**
 * Vitest 全局启动：准备隔离的测试数据库 app_test。
 *
 * 为什么单独建库而不是复用 docker-compose 的 app 库：
 *  - 测试会 TRUNCATE 全部业务表，不能污染正在运行的后端（sweeper 等 worker
 *    也在读写同一个库，会造成随机失败）；
 *  - app_test 由本文件按需创建并跑完所有迁移，测试本身零外部前置（除 db 容器在跑）。
 *
 * 连接串可用 TEST_DATABASE_URL 覆盖；默认连本机映射的 5432。
 */
import { Client } from 'pg';
import { runMigrations } from '../src/db/migrate.js';

const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/postgres';
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://app:app@localhost:5432/app_test';

export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);

  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `无法连接测试数据库（${ADMIN_URL}）。请先启动 db 容器：docker compose up -d db。原始错误：${
        (err as Error).message
      }`,
    );
  }
  try {
    // 与其他可能并行的测试进程互不干扰：拿到应用级 advisory lock 后再建库/迁移
    await admin.query('SELECT pg_advisory_lock(87654321)');
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch (err) {
    // 库已存在（42P04 duplicate_database）属正常，其余错误向上抛
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }

  // 每次启动都把迁移跑到最新（已应用的会被跳过），保证 schema 与代码一致
  await runMigrations(TEST_DATABASE_URL);
}
