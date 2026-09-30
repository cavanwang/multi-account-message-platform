/**
 * 登录端点。
 *
 * POST /api/auth/login { username, password } → 200 { accessToken }
 * 凭证错误 → 401 UNAUTHORIZED（不区分"用户不存在"与"口令错误"，避免用户名枚举）。
 *
 * refresh token（B3）在切片 5 实现，本切片只发 access token。
 */
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../errors.js';
import { UserRepo } from '../../repos/users.js';
import { signAccessToken } from '../../auth/tokens.js';

interface AuthDeps {
  readonly config: AppConfig;
  readonly pool: Pool;
}

const loginBodySchema = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

interface LoginBody {
  username: string;
  password: string;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const users = new UserRepo(deps.pool);

  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    { schema: { body: loginBodySchema } },
    async (request, reply) => {
      const { username, password } = request.body;

      const user = await users.findByUsername(username);
      // 先占位比对，避免"用户不存在立即返回"造成的时序侧信道。
      const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
      const passwordOk = await bcrypt.compare(password, hash);

      if (user === undefined || !passwordOk) {
        throw AppError.unauthorized('用户名或密码错误');
      }

      const accessToken = await signAccessToken(deps.config, {
        userId: user.id,
        username: user.username,
        role: user.role,
      });

      request.log.info({ username: user.username, role: user.role }, 'login succeeded');
      return reply.status(200).send({ accessToken });
    },
  );
}
