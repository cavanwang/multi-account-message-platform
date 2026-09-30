/**
 * 健康检查。
 *
 * 返回 schemaVersion，便于面试官用一条 curl 确认"迁移已应用"。
 * 数据库不可用时返回 503，而不是 200——健康检查必须能反映真实依赖状态。
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/env.js';
import { currentSchemaVersion } from '../../db/migrate.js';

interface HealthDeps {
  readonly config: AppConfig;
  readonly pool: Pool;
}

export async function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    try {
      // 顺带验证连接可用，而不是只看进程是否存活
      await deps.pool.query('SELECT 1');
      const schemaVersion = await currentSchemaVersion(deps.pool);
      return reply.status(200).send({ ok: true, schemaVersion });
    } catch (err) {
      return reply.status(503).send({
        ok: false,
        schemaVersion: null,
        message: err instanceof Error ? err.message : 'database unavailable',
      });
    }
  });
}
