import { defineConfig } from 'vitest/config';

/**
 * Vitest 配置：
 *  - 测试文件只放 tests/ 下的 *.test.ts（src 内不混入测试代码，生产 build 不受影响）
 *  - globalSetup 负责创建/迁移隔离的 app_test 库
 *  - 文件内并发关闭：多文件并发会抢同一库的 advisory lock / 互相 TRUNCATE
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
