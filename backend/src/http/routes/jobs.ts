/**
 * job 查询路由（切片 4，规划 04 任务 4.7 / 契约 §5）：
 *   - GET /api/jobs/:jobId - 查询异步 job 进度
 *
 * 契约：
 *   成功：200 { status, errors }（附 id / kind；契约允许多余字段）
 *         errors 非空即 failed；step ∈ create | invite | join:<accountId> | promote
 *   失败：400 VALIDATION_ERROR（jobId 非 UUID）/ 404 NOT_FOUND
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AppError } from '../errors.js';
import { JobRepo } from '../../repos/jobs.js';

interface RouteDeps {
  pool: Pool;
}

interface JobParams {
  jobId: string;
}

/** jobs.id 是 UUID；提前校验格式，避免非法值打到数据库报 22P02。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function registerJobRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const jobRepo = new JobRepo(deps.pool);

  // GET /api/jobs/:jobId - 查询 job 状态与失败步骤
  app.get<{ Params: JobParams }>(
    '/api/jobs/:jobId',
    async (request: FastifyRequest<{ Params: JobParams }>) => {
      const { jobId } = request.params;
      if (!UUID_RE.test(jobId)) {
        throw AppError.badRequest(`路径参数 jobId 必须是 UUID，当前为 "${jobId}"`);
      }

      const job = await jobRepo.findById(jobId);
      if (job === undefined) {
        throw AppError.notFound(`job ${jobId} 不存在`);
      }

      return {
        id: job.id,
        kind: job.kind,
        status: job.status,
        errors: job.errors,
      };
    },
  );
}
