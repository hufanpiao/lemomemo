// Vitest（架构 8.3）：两个项目
// • unit：src 里的组件、hook、store 测试和 tests/compat 契约测试，jsdom
// • node：shared 的测试（Deno 也跑同一批）、架构规则自测、构建脚本测试
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
          include: ['tests/shared/**/*.test.ts', 'tests/arch/**/*.test.ts', 'tests/build/**/*.test.ts'],
        },
      },
    ],
  },
});
