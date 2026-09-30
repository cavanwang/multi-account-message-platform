/**
 * 环境变量。
 *
 * 设计：模拟器**自带默认预置账号**（acct-1..acct-4），docker-compose 无需传入任何参数
 * 就能跑起来。`SEED_ACCOUNTS` 只是可选覆盖，避免"部署时必须配对配置"这种易错点。
 *
 * 与 backend/src/config/env.ts 的差别：后端对必填项"启动即失败"，模拟器则不设必填项——
 * 它的所有配置都有合理默认值，这是"一键部署"能成立的前提。
 *
 * 注意 `process.env[...]` 一律用**方括号**取值：NodeJS.ProcessEnv 是索引签名类型，
 * 配合 noPropertyAccessFromIndexSignature 时点号取值会被编译器拒绝。
 */
import type { TimingProfileName } from './types.js';

/** 默认预置账号：与后端 migration 里预置的账号一一对应。 */
const DEFAULT_SEED_ACCOUNTS = 'acct-1,acct-2,acct-3,acct-4';

/** 解析正整数；非法或非正数时回退到默认值。 */
function parseIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 解析 [0, 1] 区间的概率；非法时回退。
 * 概率类配置必须显式校验范围，否则 `Number("abc")` 得到 NaN 会让 `Math.random() < NaN`
 * 永远为 false——故障注入会静默失效，排障时极难发现。
 */
function parseProbabilityOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

/** 解析时序档案名；非法时回退 'real'（题面时序）。 */
function parseTimingProfileOr(value: string | undefined, fallback: TimingProfileName): TimingProfileName {
  return value === 'real' || value === 'fast' ? value : fallback;
}

/** 模拟器配置。全部字段只读：加载后不再变化，改动只能通过 /_mock 端点。 */
export interface GatewayConfig {
  /** 监听端口 */
  readonly port: number;
  /** 时序档案名：real | fast */
  readonly timingProfile: TimingProfileName;
  /**
   * 预置账号列表（逗号分隔）。默认 acct-1..acct-4。
   * 这些账号初始 status=idle、platformUserId=null，与后端 migration 里预置的账号一一对应。
   */
  readonly seedAccounts: readonly string[];
  /**
   * join 之后"永远不推 member_joined"的概率，取值 0..1。
   * 默认 0：常规测试必须是确定性的，否则排障时分不清是模拟器的随机性还是后端的 bug。
   * 需要验证 JOIN_TIMEOUT 时，用 POST /_mock/behavior { joinNeverArrives: 1 } 显式打开。
   */
  readonly joinNeverArrivesProbability: number;
  /** 是否启用随机限流（默认关闭，限流通过 /_mock 端点显式触发） */
  readonly randomRateLimit: boolean;
}

/**
 * 从环境变量加载配置。
 * @param source 默认取 process.env；测试时可注入一个假对象。
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    port: parseIntOr(source['PORT'], 3100),

    timingProfile: parseTimingProfileOr(source['TIMING_PROFILE'], 'real'),

    seedAccounts: (source['SEED_ACCOUNTS'] ?? DEFAULT_SEED_ACCOUNTS)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),

    joinNeverArrivesProbability: parseProbabilityOr(source['JOIN_NEVER_ARRIVES_PROBABILITY'], 0),

    randomRateLimit: source['RANDOM_RATE_LIMIT'] === 'true',
  };
}

/** 单例：入口处加载一次，之后各处直接引用。 */
export const config: GatewayConfig = loadConfig();
