/**
 * Fastify 实例组装：日志、requestId、错误处理、鉴权钩子、路由注册。
 *
 * 把"创建 app"与"启动进程"分开，便于测试里直接 buildServer() 而不用真的监听端口。
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { AppError, ErrorCode, type ErrorResponseBody, type ErrorDetails } from './errors.js';
import { makeAuthHook } from './auth-hook.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAccountRoutes } from './routes/accounts.js';

export interface ServerDeps {
  readonly config: AppConfig;
  readonly pool: Pool;
}

/** 构造（但不监听）Fastify 实例。 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, pool } = deps;

  const app = Fastify({
    logger: {
      // 输出 JSON，方便 docker logs 与采集。
      // 这里不设 transport（pino-pretty 需要额外依赖，且容器里 JSON 更实用）。
      level: config.logLevel,
    },
    // 对每个请求生成唯一 id，用于错误响应与日志关联；调用方自带 x-request-id 时沿用
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length > 0) return incoming;
      return crypto.randomUUID();
    },
  });

  // --- 全局错误处理：统一响应形状 ---
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const requestId = String(request.id);

    // 已知的业务错误：按声明的状态码与错误码返回
    if (err instanceof AppError) {
      const body: ErrorResponseBody = {
        error: {
          code: err.code,
          message: err.message,
          requestId,
          ...(err.details as ErrorDetails),
        },
      };
      // 业务错误属于预期内，用 warn 而非 error，避免污染错误告警
      request.log.warn({ err, requestId, code: err.code }, 'business error');
      return reply.status(err.statusCode).send(body);
    }

    // Fastify 的请求体/参数校验失败
    if (err.validation !== undefined && err.validation.length > 0) {
      const body: ErrorResponseBody = {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: err.message,
          requestId,
        },
      };
      request.log.warn({ requestId, validation: err.validation }, 'request validation failed');
      return reply.status(400).send(body);
    }

    // 未预期异常：记录完整堆栈，但对外只给通用信息
    request.log.error({ err, requestId }, 'unhandled error');
    const body: ErrorResponseBody = {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: '服务器内部错误',
        requestId,
      },
    };
    return reply.status(500).send(body);
  });

  // --- 404：与错误契约保持一致 ---
  app.setNotFoundHandler((request, reply) => {
    const body: ErrorResponseBody = {
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `路由不存在：${request.method} ${request.url}`,
        requestId: String(request.id),
      },
    };
    return reply.status(404).send(body);
  });

  // --- 公开路由（不需要鉴权） ---
  await registerHealthRoutes(app, { config, pool });
  await registerAuthRoutes(app, { config, pool });

  // --- 受保护路由 ---
  // 用一个子上下文加 preHandler，避免逐个路由重复声明；
  // 后续切片的业务路由都注册在这个作用域内（注意：必须 await register，
  // 否则钩子注册会晚于首次请求，出现“未鉴权就能访问”的空窗）。
  await app.register(async (protectedScope) => {
    protectedScope.addHook('preHandler', makeAuthHook(config));
  
    // 切片 2：账号管理路由
    await registerAccountRoutes(protectedScope, { config, pool });
  
    // 切片 3+ 在此注册：/api/groups、/api/jobs ...
  });

  return app;
}
