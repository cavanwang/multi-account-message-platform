/**
 * 环境变量解析与校验。
 *
 * 设计原则：**启动即失败**。任何缺失或格式错误的环境变量都会让进程以非 0 退出码退出，
 * 并打印明文错误信息——而不是等到第一次用到该变量时才在运行期崩溃。
 *
 * 不使用 zod 等库：变量数量少，手写可给出更可读的错误信息，且少一个运行时依赖。
 */

/** 解析结果：全部为已校验的强类型值。 */
export interface AppConfig {
  /** 后端 HTTP 监听端口 */
  readonly port: number;
  /** PostgreSQL 连接串 */
  readonly databaseUrl: string;
  /** 消息网关模拟器地址（切片 1 实现） */
  readonly gatewayUrl: string;
  /** Agent 服务模拟器地址（切片 5 实现） */
  readonly agentUrl: string;
  /** access token 的 HS256 签名密钥 */
  readonly jwtSecret: string;
  /** access token 有效期（秒），默认 900 = 15 分钟 */
  readonly accessTokenTtlSeconds: number;
  /** pino 日志级别 */
  readonly logLevel: LogLevel;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** 收集所有校验错误，一次性报给使用者，避免"改一个跑一次"。 */
class EnvValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `环境变量校验失败（共 ${problems.length} 项）：\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * 读取并校验环境变量。
 * @param source 默认取 process.env；测试时可注入一个假对象。
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  /** 取必填字符串；空字符串视为缺失。 */
  const required = (key: string): string | undefined => {
    const raw = source[key];
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${key} 未设置`);
      return undefined;
    }
    return raw;
  };

  /** 取可选的整数字符串。 */
  const optionalInt = (key: string, fallback: number, min: number, max: number): number => {
    const raw = source[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      problems.push(`${key} 必须是 ${min}..${max} 之间的整数，当前为 "${raw}"`);
      return fallback;
    }
    return parsed;
  };

  const port = optionalInt('PORT', 3000, 1, 65535);
  const accessTokenTtlSeconds = optionalInt('ACCESS_TOKEN_TTL_SECONDS', 900, 1, 86_400);

  const databaseUrl = required('DATABASE_URL');
  const gatewayUrl = required('GATEWAY_URL');
  const agentUrl = required('AGENT_URL');
  const jwtSecret = required('JWT_SECRET');

  // URL 类变量额外校验协议与可解析性
  for (const [key, value] of [
    ['DATABASE_URL', databaseUrl],
    ['GATEWAY_URL', gatewayUrl],
    ['AGENT_URL', agentUrl],
  ] as const) {
    if (value === undefined) continue;
    try {
      const parsed = new URL(value);
      if (key === 'DATABASE_URL') {
        if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
          problems.push(`${key} 必须是 postgres:// 或 postgresql:// 连接串`);
        }
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`${key} 必须是 http:// 或 https:// 地址`);
      }
    } catch {
      problems.push(`${key} 不是合法 URL："${value}"`);
    }
  }

  // 弱密钥警告不影响启动，但生产环境应替换
  if (jwtSecret !== undefined && jwtSecret.length < 16) {
    problems.push('JWT_SECRET 长度至少 16 个字符（生成方式见 .env.example）');
  }

  const rawLogLevel = source['LOG_LEVEL'];
  let logLevel: LogLevel = 'info';
  if (rawLogLevel !== undefined && rawLogLevel.trim() !== '') {
    if ((LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
      logLevel = rawLogLevel as LogLevel;
    } else {
      problems.push(`LOG_LEVEL 必须是 ${LOG_LEVELS.join(' | ')} 之一，当前为 "${rawLogLevel}"`);
    }
  }

  if (problems.length > 0) {
    throw new EnvValidationError(problems);
  }

  // 到这里所有必填项都已通过校验，断言收窄类型
  return {
    port,
    databaseUrl: databaseUrl as string,
    gatewayUrl: gatewayUrl as string,
    agentUrl: agentUrl as string,
    jwtSecret: jwtSecret as string,
    accessTokenTtlSeconds,
    logLevel,
  };
}
