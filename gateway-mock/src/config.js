/**
 * 环境变量。
 *
 * 设计：模拟器**自带默认预置账号**（acct-1..acct-4），docker-compose 无需传入任何参数
 * 就能跑起来。`SEED_ACCOUNTS` 只是可选覆盖，避免"部署时必须配对配置"这种易错点。
 */
function parseIntOr(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  /** 监听端口 */
  port: parseIntOr(process.env.PORT, 3100),

  /** 时序档案名：real | fast */
  timingProfile: process.env.TIMING_PROFILE ?? 'real',

  /**
   * 预置账号列表（逗号分隔）。默认 acct-1..acct-4。
   * 这些账号初始 status=idle、platformUserId=null，与后端 migration 里预置的账号一一对应。
   */
  seedAccounts: (process.env.SEED_ACCOUNTS ?? 'acct-1,acct-2,acct-3,acct-4')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),

  /**
   * join 之后"永远不推 member_joined"的概率，取值 0..1。
   * 默认 0：常规测试必须是确定性的，否则排障时分不清是模拟器的随机性还是后端的 bug。
   * 需要验证 JOIN_TIMEOUT 时，用 POST /_mock/behavior { joinNeverArrives: 1 } 显式打开。
   */
  joinNeverArrivesProbability: Number(process.env.JOIN_NEVER_ARRIVES_PROBABILITY ?? 0),

  /** 是否启用随机限流（默认关闭，限流通过 /_mock 端点显式触发） */
  randomRateLimit: process.env.RANDOM_RATE_LIMIT === 'true',
};
