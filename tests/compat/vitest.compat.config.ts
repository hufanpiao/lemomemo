// 只给 tests/compat/run-compat.ts 用：跑取出到 .compat-base/ 的基线契约用例（Node 环境，不用 jsdom，不带根目录的项目划分）
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname + '/../..',
    include: ['.compat-base/tests/compat/**/*.test.ts'],
    environment: 'node',
    // 用例打本地 Supabase，网络慢时给宽一点
    testTimeout: 30_000,
  },
});
