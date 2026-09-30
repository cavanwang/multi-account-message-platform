/**
 * SQL 迁移框架。
 *
 * 目标（对应需求 A0）：
 *  1. **可重复执行**：对同一套 schema 反复运行不报错、不重复应用。
 *  2. **schema 落后于代码时服务拒绝启动**：应用侧与代码侧的最大版本号必须一致。
 *  3. **并发安全**：多实例同时启动时，只允许一个实例执行迁移（advisory lock）。
 *
 * 约定：
 *  - 迁移文件放在 `backend/migrations/`，命名 `NNNN_<name>.sql`，NNNN 为 4 位序号。
 *  - 序号即版本号，**只增不改**：已应用的迁移文件不得修改内容（改了不会重跑）。
 *  - 每个迁移在**单个事务**内执行，并写入一条 schema_migrations 记录；失败整体回滚。
 *  - 运行时不依赖连接池：迁移可能在服务启动前执行，用独立的 pg.Client 更直观。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

/**
 * 用于串行化迁移的 advisory lock 键。
 * 取值任意但必须全局唯一；"0x4d494752" 是 "MIGR" 的十六进制。
 */
const MIGRATION_LOCK_KEY = 0x4d4947_52;

/** 一个迁移文件。 */
export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
}

/** 迁移执行结果。 */
export interface MigrationResult {
  readonly applied: readonly MigrationFile[];
  readonly skipped: readonly MigrationFile[];
  /** 应用完成后数据库中的最大版本号 */
  readonly currentVersion: number;
}

/** 校验失败时抛出，调用方据此决定是否让进程退出。 */
export class SchemaVersionError extends Error {
  constructor(
    message: string,
    readonly appliedVersion: number,
    readonly expectedVersion: number,
  ) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

/**
 * 迁移目录的默认位置：相对于本文件所在目录向上找到 `migrations/`。
 * 编译后位于 `dist/db/`，源码位于 `src/db/`，两种情况都能定位到 `backend/migrations/`。
 */
export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = .../backend/(src|dist)/db  →  向上两级到包根
  return path.resolve(here, '..', '..', 'migrations');
}

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/i;

/**
 * 读取并解析迁移目录，按版本号升序返回。
 * 文件命名不合规、或版本号重复时抛错——宁可在启动时炸掉，也不要静默跳过迁移。
 */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const migrations: MigrationFile[] = [];
  const seenVersions = new Map<number, string>();

  for (const filename of entries.sort()) {
    if (!filename.endsWith('.sql')) continue;

    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) {
      throw new Error(
        `迁移文件命名不合规：${filename}（应为 NNNN_name.sql，如 0001_init.sql）`,
      );
    }
    const version = Number(match[1]);
    const name = match[2] as string;

    const duplicate = seenVersions.get(version);
    if (duplicate !== undefined) {
      throw new Error(`迁移版本号重复：${version} 同时出现在 ${duplicate} 与 ${filename}`);
    }
    seenVersions.set(version, filename);

    migrations.push({
      version,
      name,
      filename,
      sql: await readFile(path.join(dir, filename), 'utf8'),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

/** 读取库中已应用的最大版本号；schema_migrations 不存在时返回 0。 */
async function readAppliedVersion(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ version: number | null }>(
    'SELECT max(version) AS version FROM schema_migrations',
  );
  return rows[0]?.version ?? 0;
}

/**
 * 执行迁移。
 * @param databaseUrl PostgreSQL 连接串
 * @param migrationsDir 迁移目录，默认 {@link defaultMigrationsDir}
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<MigrationResult> {
  const migrations = await loadMigrations(migrationsDir);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // 1) 建记录表。用 IF NOT EXISTS 保证本步骤可重复执行。
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // 2) 并发保护：同一时刻只允许一个实例迁移。
    //    用 pg_advisory_lock（会话级）而不是 xact 级，因为要跨多个迁移事务持有。
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const appliedBefore = await readAppliedVersion(client);
    const pending = migrations.filter((m) => m.version > appliedBefore);
    const skipped = migrations.filter((m) => m.version <= appliedBefore);

    const applied: MigrationFile[] = [];
    for (const migration of pending) {
      // 3) 每个迁移一个事务：SQL 与版本记录要么都在，要么都不在。
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        );
        await client.query('COMMIT');
        applied.push(migration);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `迁移 ${migration.filename} 执行失败：${(err as Error).message}`,
          { cause: err },
        );
      }
    }

    const currentVersion = await readAppliedVersion(client);
    return { applied, skipped, currentVersion };
  } finally {
    // 释放锁（连接关闭时 PostgreSQL 也会自动释放，这里显式一点便于排查）
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      // 连接可能已断开，忽略
    }
    await client.end();
  }
}

/**
 * 校验数据库 schema 版本与代码期望是否一致。
 *
 * 两种不一致都拒绝启动：
 *  - 库落后于代码（`<`）：说明有迁移没跑，运行时会因缺列/缺表而报错，属于"必须阻止"的情况。
 *  - 库超前于代码（`>`）：说明代码比库旧，可能是回滚部署，同样不安全。
 */
export async function assertSchemaUpToDate(
  databaseUrl: string,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<number> {
  const expected = await loadMigrations(migrationsDir);
  const expectedVersion = expected.at(-1)?.version ?? 0;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // schema_migrations 缺失说明连迁移都没跑过，直接视为落后
    const { rows: tableRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'schema_migrations'
       ) AS exists`,
    );
    const appliedVersion = tableRows[0]?.exists === true ? await readAppliedVersion(client) : 0;

    if (appliedVersion !== expectedVersion) {
      const direction = appliedVersion < expectedVersion ? '落后于' : '超前于';
      throw new SchemaVersionError(
        `数据库 schema ${direction}代码：applied=${appliedVersion} expected=${expectedVersion}。` +
          (appliedVersion < expectedVersion
            ? '请先执行 migration（npm run migrate / docker compose up 会自动执行）。'
            : '当前代码版本过旧，请更新代码或回滚数据库。'),
        appliedVersion,
        expectedVersion,
      );
    }
    return appliedVersion;
  } finally {
    await client.end();
  }
}

/** 只读地查询当前 schema 版本，供 /api/health 使用。 */
export async function currentSchemaVersion(client: pg.Pool | pg.Client): Promise<number> {
  const { rows } = await client.query<{ version: number | null }>(
    'SELECT max(version) AS version FROM schema_migrations',
  );
  return rows[0]?.version ?? 0;
}
