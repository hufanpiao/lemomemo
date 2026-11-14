// Playwright 快读组（B2 FA-6 ①，安全审查 L5）：带 supabase 地址的 e2e 构建，跑 tests/e2e/b2-first-screen-supabase.spec.ts、r402-webp-wasm.spec.ts 、b5-vault.spec.ts（B5 隐私记，同样要 /sb 地址）和 b4b1-attachments.spec.ts（B4b-1 附件，签名要会话令牌）
// 默认的假后端组（playwright.config.ts）构建时没配 VITE_PUBLIC_SUPABASE_URL，启动关口的快读分支跑不到；这一组把地址配成同源 /sb、
// anon key 用假值 FAKE_ANON_KEY（tests/e2e/fake-values.ts，一看就是假的，不是密钥），验证：
// • 关口走快读（两张表各一次、带 apikey 和 Bearer、只发往同源 /sb）；• supabase-js 那一块在今天页画出来以后才下载
// • R-402（11-13）：插图走 wasm 编 webp 一直到上传请求（上传器等同步引擎把新建发出去才传，没配地址的默认组起不了同步）
// 和默认组、真后端组能同时跑：服务 8791、产物 dist/web-fastread、假后端 9193、9192、wrangler 状态 .wrangler/state-e2e-fastread、调试端口 9233
// 其余（CSP fixture、产物指纹 globalSetup、本机复用规则、看门狗）和默认组一样，见 playwright.config.ts
import { relative } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { webOutDir } from './build/assemble_web.mjs';
import { reuseServers } from './tools/e2e/reuse-servers.mjs';
import { FAKE_ANON_KEY, FAKE_PORT_ENV, e2eBindings, fakePorts, type FakePorts } from './tests/e2e/fake-values.ts';
import { NO_BACKEND_GLOBAL_TIMEOUT_MS, globalTimeoutMs } from './tests/e2e/global-timeout.ts';

const PORT = 8791;
const FASTREAD_FAKE_PORTS: FakePorts = { s3: 9193, supabase: 9192 };
// 构建（webServer 里的 npm run build）、产物指纹（globalSetup）、用例（核对 apikey）都从环境变量读，所以在这里设好；
// 子进程和测试 worker 都继承。一律强制设置（安全复审 L7）：本机 shell 里有真实的地址、anon key 也不沿用，这一组只连本机假值
process.env['LEMO_WEB_OUT'] = 'dist/web-fastread';
process.env['LEMO_WS_PORT'] = String(PORT);
process.env['VITE_PUBLIC_SUPABASE_URL'] = `http://127.0.0.1:${PORT}/sb`;
process.env['VITE_PUBLIC_ANON_KEY'] = FAKE_ANON_KEY;

const WEB_OUT = relative(import.meta.dirname, webOutDir(import.meta.dirname, process.env)).replaceAll('\\', '/');
const FAKE = fakePorts(process.env, FASTREAD_FAKE_PORTS);
// 默认不复用，设了 LEMO_E2E_REUSE=1 才复用（tools/e2e/reuse-servers.mjs）；改了假后端端口一律不复用
const REUSE = reuseServers(process.env) && !(process.env[FAKE_PORT_ENV.s3] || process.env[FAKE_PORT_ENV.supabase]);
const BINDINGS = Object.entries(e2eBindings(FAKE))
  .map(([k, v]) => `--binding ${k}=${v}`)
  .join(' ');

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/b2-first-screen-supabase.spec.ts', '**/r402-webp-wasm.spec.ts', '**/b5-vault.spec.ts', '**/b4b1-attachments.spec.ts', '**/b4b2-find.spec.ts'],
  fullyParallel: true,
  globalTimeout: globalTimeoutMs(process.env, NO_BACKEND_GLOBAL_TIMEOUT_MS),
  globalSetup: './tests/e2e/dist-fingerprint.ts',
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-fastread' }]] : 'list',
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
      command: `npm run build -- --mode e2e && npx wrangler pages dev ${WEB_OUT} --ip 127.0.0.1 --port ${PORT} --compatibility-date 2026-10-01 --persist-to .wrangler/state-e2e-fastread --inspector-port 9233 ${BINDINGS}`,
      url: `http://127.0.0.1:${PORT}/app/`,
      reuseExistingServer: REUSE,
      timeout: 180_000,
      env: { WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? '' },
    },
  ],
});
