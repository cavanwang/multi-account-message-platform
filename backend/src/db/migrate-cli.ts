#!/usr/bin/env node
/**
 * 迁移 CLI。
 *
 *   npm run migrate        应用所有未执行的迁移（幂等）
 *   npm run migrate:check  只校验，不修改数据库；版本不一致时退出码 1
 *
 * 容器启动命令里使用 `node dist/db/migrate-cli.js up`。
 */
import { loadConfig } from '../config/env.js';
import { assertSchemaUpToDate, runMigrations, SchemaVersionError } from './migrate.js';

type Command = 'up' | 'check';

function usage(): never {
  console.error('用法：migrate-cli.ts <up|check>');
  process.exit(2);
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command !== 'up' && command !== 'check') usage();

  // 迁移只需要 DATABASE_URL；但复用统一的环境校验，保证失败信息一致。
  const config = loadConfig();

  if (command === 'check') {
    const version = await assertSchemaUpToDate(config.databaseUrl);
    console.log(`[migrate] schema 版本一致：${version}`);
    return;
  }

  const result = await runMigrations(config.databaseUrl);
  if (result.applied.length === 0) {
    console.log(`[migrate] 无需迁移，当前版本 ${result.currentVersion}`);
  } else {
    for (const m of result.applied) {
      console.log(`[migrate] 已应用 ${m.filename}`);
    }
    console.log(
      `[migrate] 完成：新应用 ${result.applied.length} 个，跳过 ${result.skipped.length} 个，当前版本 ${result.currentVersion}`,
    );
  }
}

main().catch((err: unknown) => {
  if (err instanceof SchemaVersionError) {
    console.error(`[migrate] ${err.message}`);
  } else {
    console.error('[migrate] 失败：', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
