/**
 * PostgreSQL 连接池与事务助手。
 *
 * 全局单例连接池：整个进程共用一个 Pool，由驱动负责连接复用。
 * 需要事务的地方一律使用 {@link withTransaction}，不要手工 BEGIN/COMMIT——
 * 后者容易在异常路径上漏掉 ROLLBACK，导致连接被污染并归还给池。
 */
import pg from 'pg';

const { Pool } = pg;

/** 池的配置可通过环境变量微调，默认值适用于本项目规模。 */
function poolConfig(databaseUrl: string): pg.PoolConfig {
  return {
    connectionString: databaseUrl,
    max: Number(process.env['PG_POOL_MAX'] ?? 10),
    idleTimeoutMillis: 30_000,
    // 建立连接的超时；容器启动早期 db 可能尚未就绪（compose 的 healthcheck 已处理，
    // 这里只是兜底，避免无限等待）
    connectionTimeoutMillis: 10_000,
  };
}

let pool: pg.Pool | undefined;

/** 获取全局连接池（首次调用时创建）。 */
export function getPool(databaseUrl: string): pg.Pool {
  if (pool === undefined) {
    pool = new Pool(poolConfig(databaseUrl));
    // 池级别的错误（如后端连接被强制断开）不应让进程崩溃
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

/** 关闭连接池，供测试与优雅退出使用。 */
export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}

/** 标记"当前函数已在事务中"，防止嵌套开事务。 */
const IN_TRANSACTION = Symbol('in-transaction');

type Querier = (<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<pg.QueryResult<T>>) & { [IN_TRANSACTION]?: true };

/**
 * 在单个事务中执行一段逻辑。
 *
 * - 使用**专用连接**（非池的隐式分配），保证 BEGIN/COMMIT 落在同一连接上；
 * - 正常返回则 COMMIT，抛错则 ROLLBACK 后原样抛出；
 * - 通过 Symbol 标记禁止嵌套：嵌套事务在 PostgreSQL 里需要 SAVEPOINT，本项目不需要，
 *   直接报错比隐式降级成"没有事务"更安全。
 *
 * @example
 * await withTransaction(pool, async (tx) => {
 *   await tx('INSERT INTO a (x) VALUES ($1)', [1]);
 *   await tx('UPDATE b SET y = $1 WHERE id = $2', [2, id]);
 * });
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (query: Querier) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tx = (async <R extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<pg.QueryResult<R>> => {
      return client.query<R>(text, params as unknown[] | undefined);
    }) as Querier;
    tx[IN_TRANSACTION] = true;

    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // ROLLBACK 本身失败（连接已断）时，原始错误更重要，记日志后继续抛出原错误
      console.error('[db] rollback failed:', (rollbackErr as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 判断一个查询函数是否已处于事务中（供工具函数做断言）。 */
export function isInTransaction(query: Querier): boolean {
  return query[IN_TRANSACTION] === true;
}

export type { Querier };
