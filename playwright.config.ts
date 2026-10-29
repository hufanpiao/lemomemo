// Playwright（架构 8.3）：chromium + webkit，服务用 wrangler pages dev dist/web 起（带 _headers 的 CSP 和 Pages Functions）
// 先按 e2e 模式构建（connect-src 里的 ws 指向本机 8788），再用项目里的 wrangler（devDependency）起服务
// /files、/sb 函数的环境变量用 --binding 指向本机假后端（tests/e2e/fake-backends.ts：S3 替身 + 假 Supabase；值全是假的，见 fake-values.ts）
// 和真后端组（playwright.real.config.ts）能同时跑（接手清单 E2E-parallel，R-267 D1）：假后端默认 9199、9198（真后端组 9197、9196），
// 产物 dist/web（真后端组 dist/web-real），wrangler 本地状态 .wrangler/state-e2e、调试端口 9230（真后端组 state-e2e-real、9231）
// globalTimeout 默认 20 分钟，E2E_GLOBAL_TIMEOUT_MS 可改（tests/e2e/global-timeout.ts，E2E-webkit-hang）
import { defineConfig, devices } from '@playwright/test';
import { DEFAULT_FAKE_PORTS, FAKE_PORT_ENV, e2eBindings, fakePorts } from './tests/e2e/fake-values.ts';
import { NO_BACKEND_GLOBAL_TIMEOUT_MS, globalTimeoutMs } from './tests/e2e/global-timeout.ts';

const PORT = 8788;
const FAKE = fakePorts(process.env, DEFAULT_FAKE_PORTS);
/**
 * 本机默认复用已经在跑的假后端和 wrangler（CI 不复用）。设了 LEMO_E2E_FAKE_S3_PORT 或 LEMO_E2E_FAKE_SB_PORT 时一律不复用：
 * 8788 上那个旧 wrangler 的 binding 还指着默认的 9199、9198，复用了等于端口覆盖没生效（审查建议，10-30）
 */
const FAKE_PORTS_OVERRIDDEN = Boolean(process.env[FAKE_PORT_ENV.s3] || process.env[FAKE_PORT_ENV.supabase]);
const REUSE = process.env.CI !== 'true' && !FAKE_PORTS_OVERRIDDEN;
const BINDINGS = Object.entries(e2eBindings(FAKE))
  .map(([k, v]) => `--binding ${k}=${v}`)
  .join(' ');

export default defineConfig({
  testDir: 'tests/e2e',
  // 只认 *.spec.ts；tests/e2e/*.preview.test.ts 是 Vitest 跑的预览环境用例（B0 集成）
  testMatch: '**/*.spec.ts',
  // *.real.spec.ts 是真后端那组（playwright.real.config.ts，npm run e2e:real），这里不跑；两组都写 dist/web，不能同时跑
  testIgnore: '**/*.real.spec.ts',
  fullyParallel: true,
  globalTimeout: globalTimeoutMs(process.env, NO_BACKEND_GLOBAL_TIMEOUT_MS),
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
      url: `http://127.0.0.1:${FAKE.supabase}/health`,
      reuseExistingServer: REUSE,
      timeout: 30_000,
      env: { [FAKE_PORT_ENV.s3]: String(FAKE.s3), [FAKE_PORT_ENV.supabase]: String(FAKE.supabase) },
    },
    {
      command: `npm run build -- --mode e2e && npx wrangler pages dev dist/web --ip 127.0.0.1 --port ${PORT} --compatibility-date 2026-10-01 --persist-to .wrangler/state-e2e --inspector-port 9230 ${BINDINGS}`,
      url: `http://127.0.0.1:${PORT}/app/`,
      reuseExistingServer: REUSE,
      timeout: 180_000,
      env: { WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? '' },
    },
  ],
});
