// Vitest（架构 8.3）：两个项目
// • unit：src 里的组件、hook、store 测试和 tests/compat 契约测试，jsdom
// • node：shared 的测试（Deno 也跑同一批）、架构规则自测、构建脚本测试、Pages Functions、数据清单生成器
// test:tz（build/run_tz_tests.mjs）把整套在三个时区各跑一遍
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('4.0.0'),
    __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'tests/compat/**/*.test.ts'],
          css: { modules: { classNameStrategy: 'non-scoped' } },
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          // tests/functions、tests/data-manifest（前端 B）B0 集成时并进来；tests/e2e/*.preview.test.ts 没有预览环境的变量时整组跳过
          include: [
            'tests/shared/**/*.test.ts',
            'tests/arch/**/*.test.ts',
            'tests/build/**/*.test.ts',
            'tests/functions/**/*.test.ts',
            // supabase/functions 里能脱离 Deno 测的纯逻辑（预览专用的 db-probe 等），数据库用假的
            'tests/edge/**/*.test.ts',
            'tests/data-manifest/**/*.test.ts',
            'tests/e2e/**/*.preview.test.ts',
          ],
        },
      },
    ],
  },
});
