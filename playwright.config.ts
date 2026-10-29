// Playwright（架构 8.3）：chromium + webkit，服务用 wrangler pages dev dist/web 起（带 _headers 的 CSP 和 Pages Functions）
// 先按 e2e 模式构建（connect-src 里的 ws 指向本机 8788），再用项目里的 wrangler（devDependency）起服务
// /files、/sb 函数的环境变量用 --binding 指向本机假后端（tests/e2e/fake-backends.ts：S3 替身 + 假 Supabase；值全是假的，见 fake-values.ts）
import { defineConfig, devices } from '@playwright/test';
import { E2E_BINDINGS, FAKE_SUPABASE_PORT } from './tests/e2e/fake-values.ts';

const PORT = 8788;
const BINDINGS = Object.entries(E2E_BINDINGS)
  .map(([k, v]) => `--binding ${k}=${v}`)
  .join(' ');

export default defineConfig({
  testDir: 'tests/e2e',
  // 只认 *.spec.ts；tests/e2e/*.preview.test.ts 是 Vitest 跑的预览环境用例（B0 集成）
  testMatch: '**/*.spec.ts',
  // *.real.spec.ts 是真后端那组（playwright.real.config.ts，npm run e2e:real），这里不跑；两组都写 dist/web，不能同时跑
  testIgnore: '**/*.real.spec.ts',
  fullyParallel: true,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['iPhone 15'] } },
  ],
  webServer: [
    {
      command: 'node tests/e2e/fake-backends.ts',
      url: `http://127.0.0.1:${FAKE_SUPABASE_PORT}/health`,
      reuseExistingServer: process.env.CI !== 'true',
      timeout: 30_000,
    },
    {
      command: `npm run build -- --mode e2e && npx wrangler pages dev dist/web --ip 127.0.0.1 --port ${PORT} --compatibility-date 2026-10-01 ${BINDINGS}`,
      url: `http://127.0.0.1:${PORT}/app/`,
      reuseExistingServer: process.env.CI !== 'true',
      timeout: 180_000,
      env: { WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? '' },
    },
  ],
});
