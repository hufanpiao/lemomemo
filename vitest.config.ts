// Vitest（架构 8.3）：三个项目
// • unit：src 里的组件、hook、store 测试和 tests/compat 契约测试，jsdom
// • node：shared 的测试（Deno 也跑同一批）、架构规则自测、构建脚本测试、Pages Functions、数据清单生成器
// • node-slow：node 里会起子进程（python、PowerShell、node）或真跑 ESLint、stylelint、TypeScript 编译器、PGlite 的文件（SLOW_NODE_TESTS）
// unit、node 保持默认 5 秒超时，真卡住能及时发现；只有 node-slow 放宽到 30 秒（机器忙时子进程、编译器会慢好几倍，曾偶发 5 秒超时）。
// node-slow 排在第二批（sequence.groupOrder = 1）：unit、node 先跑完再跑它。混在一起时重型文件的子进程把核占满，
// 纯测试里一连串 crypto.subtle 之类的异步往返要排队等调度，单跑 0.2 秒的用例也会拖过 5 秒；分开以后全量墙钟基本不变。
// 新写的测试只要起子进程或用上面几种重型库，就要登记进 SLOW_NODE_TESTS；tests/arch/coverage.test.ts 会扫出漏登记的。
// test:tz（build/run_tz_tests.mjs）把整套在三个时区各跑一遍
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

/** node 项目里的重型测试文件：起子进程，或真跑 ESLint / stylelint / TypeScript / PGlite（路径相对仓库根目录） */
export const SLOW_NODE_TESTS: readonly string[] = [
  'tests/arch/check-arch.test.ts', // python build/check_arch.py
  'tests/arch/eslint.test.ts', // ESLint API（整套规则、类型信息）
  'tests/arch/stylelint.test.ts', // stylelint API
  'tests/arch/tsc.test.ts', // TypeScript 编译器
  'tests/build/check-backend.test.ts', // python build/check_backend.py（建 TypeScript 类型检查器）
  'tests/build/check-size.test.ts', // 另起 node 跑 build/check_size.mjs
  'tests/build/fn-version-gate-coverage.test.ts', // TypeScript 编译器
  'tests/build/login-token-tests.test.ts', // PowerShell
  'tests/build/login-token-tests-run.test.ts', // PowerShell（经 login-token-fake.ts）
  'tests/build/set-cron-secret.test.ts', // PowerShell（有 docker 时还起容器）
  'tests/build/set-fn-role-passwords.test.ts', // PowerShell、python
  'tests/build/set-fn-role-passwords-run.test.ts', // PowerShell
  'tests/data-manifest/generate.test.ts', // PGlite 跑全部迁移
  'tests/data-manifest/grant-matrix.test.ts', // PGlite 跑全部迁移
];
/** node-slow 的单条用例超时：单跑最慢的一条约 6 秒，三个全量同时跑时最慢约 19 秒；钩子（建 PGlite 等）给两倍 */
export const SLOW_TEST_TIMEOUT = 30_000;

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
          // 重型文件归 node-slow，这里排除，免得跑两遍
          exclude: [...configDefaults.exclude, ...SLOW_NODE_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'node-slow',
          environment: 'node',
          include: [...SLOW_NODE_TESTS],
          testTimeout: SLOW_TEST_TIMEOUT,
          hookTimeout: 2 * SLOW_TEST_TIMEOUT,
          // 第二批跑，不和 unit、node 抢核（见文件头）
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
