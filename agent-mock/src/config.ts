/**
 * Agent 模拟器配置。
 * 端口通过环境变量 AGENT_MOCK_PORT 覆盖（测试时用）。
 */
export interface AgentConfig {
  readonly port: number;
}

export function loadConfig(): AgentConfig {
  const port = Number(process.env['AGENT_MOCK_PORT'] ?? 3003);
  return { port };
}
