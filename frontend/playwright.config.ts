/**
 * Playwright UI 端到端测试配置（C3 选做，5.26）。
 *
 * 被测对象是 compose 部署的前端（nginx，默认 http://localhost:5173），
 * Playwright 自身不起 server：运行前请先 `docker compose up -d`。
 * 宿主机可用 PLAYWRIGHT_BASE_URL 覆盖地址。
 *
 * 运行：npx playwright test（或 scripts/test-playwright.sh，会自动装 chromium）。
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests-e2e',
  // 全套操作都在 compose 本地网络，单测级超时即可
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: process.env['CI'] ? 'line' : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
