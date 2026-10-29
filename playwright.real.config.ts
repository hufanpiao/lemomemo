// Playwright 真后端那组（需求记录 R-255，接手清单 E2E-REAL）：只跑 tests/e2e/**/*.real.spec.ts，默认只跑 chromium
//
// 用法：npm run e2e:real:up → npm run e2e:real（先 real-backend.mjs check，再跑本配置）→ npm run e2e:real:down
// • 加载时用 tools/e2e/real-backend.mjs 的 statusEnv() 取 lemo-e2e（project_id，api 55321、Mailpit 55324）的地址和密钥；
//   后端没起就直接抛错，提示先跑 npm run e2e:real:up。取到的值只放进本进程的环境变量（worker 继承），不打印
// • webServer：先 node build/build_web.mjs --mode e2e-real 构建（VITE_PUBLIC_SUPABASE_URL = http://127.0.0.1:8789/sb、VITE_PUBLIC_ANON_KEY 由这里传入），
//   再用 wrangler pages dev 起 8789：/sb 的 SUPABASE_UPSTREAM 指 lemo-e2e 的 55321、SUPABASE_ANON_KEY 用取到的值，PROXY_SECRET 仍是假值；
//   /files 的 R2 照旧指假 S3（tests/e2e/fake-backends.ts 的 9199；它顺带起的 9198 假 Supabase 这组用不到）
// • reuseExistingServer 一律 false：8789、9199 被占着就直接失败，不会连上别人起的服务
// • ⚠ 和无后端组（playwright.config.ts，8788）都写 dist/web：两组不能同时跑，后构建的会把先跑那组的产物换掉
// • ⚠ 失败时留下的 trace（test-results/**/trace.zip，CI 的 html 报告里也有）含本地 lemo-e2e 的 anon key（请求头、页面里的构建配置）
//   和测试账号的会话令牌（localStorage、/sb 请求的 Authorization）。都是本地演示密钥和一次性测试账号，但 CI 上传报告、产物前要注意：
//   不要公开上传，或者上传前删掉 trace（真后端组不截图、不录屏，就是为了少带这些）
import { defineConfig, devices } from '@playwright/test';
import { E2E_BINDINGS, FAKE_SUPABASE_PORT } from './tests/e2e/fake-values.ts';
import { REAL_ENV, assertE2eOrigins } from './tests/e2e/real-backend.ts';
import { statusEnv } from './tools/e2e/real-backend.mjs';

const PORT = 8789;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * 主进程取一次写进环境变量；worker 重新加载本配置时已经有了，不再跑 supabase status。
 * 不管是哪种（刚取的、继承来的、调用方自己设的），下面 assertE2eOrigins 都照查：API 和 SUPABASE_UPSTREAM 必须正好是 127.0.0.1:55321，
 * Mailpit 正好是 127.0.0.1:55324（审查建议，10-30：原来四个变量都设了就直接 return，护栏被跳过）
 */
function loadBackend(): void {
  const have = [REAL_ENV.api, REAL_ENV.anonKey, REAL_ENV.serviceKey, REAL_ENV.mailpit].every((k) => process.env[k]);
  if (!have) {
    let e: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string; MAILPIT_URL: string };
    try {
      e = statusEnv();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`playwright.real.config.ts：取不到 lemo-e2e 专用后端的地址和密钥。\n${msg}`);
    }
    process.env[REAL_ENV.api] = e.API_URL;
    process.env[REAL_ENV.anonKey] = e.ANON_KEY;
    process.env[REAL_ENV.serviceKey] = e.SERVICE_ROLE_KEY;
    process.env[REAL_ENV.mailpit] = e.MAILPIT_URL;
  }
}
loadBackend();

const API = process.env[REAL_ENV.api] ?? '';
const ANON = process.env[REAL_ENV.anonKey] ?? '';
const UPSTREAM = API;
assertE2eOrigins({ api: API, upstream: UPSTREAM, mailpit: process.env[REAL_ENV.mailpit] ?? '' });
const BINDINGS = Object.entries({ ...E2E_BINDINGS, SUPABASE_UPSTREAM: UPSTREAM, SUPABASE_ANON_KEY: ANON })
  .map(([k, v]) => `--binding ${k}=${v}`)
  .join(' ');

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.real.spec.ts',
  // 同一个专用库、每条用例自己建账号，互不干扰；但 wrangler 只有一个，并发别太高
  fullyParallel: true,
  ...(process.env.CI === 'true' ? { workers: 2 } : {}),
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : 'list',
  // 失败时留 trace，但不截图、不录屏（页面里有会话令牌）
  use: { baseURL: ORIGIN, trace: 'retain-on-failure', screenshot: 'off', video: 'off' },
  // 默认只跑 chromium；E2E_REAL_WEBKIT=1 时多跑 webkit（TC-B1-16 要求桌面 WebKit 也走一遍网页登录）
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.E2E_REAL_WEBKIT === '1' ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
  webServer: [
    {
      command: 'node tests/e2e/fake-backends.ts',
      url: `http://127.0.0.1:${FAKE_SUPABASE_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `node build/build_web.mjs --mode e2e-real && npx wrangler pages dev dist/web --ip 127.0.0.1 --port ${PORT} --compatibility-date 2026-10-01 ${BINDINGS}`,
      url: `${ORIGIN}/app/`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        WRANGLER_SEND_METRICS: 'false',
        CI: process.env.CI ?? '',
        VITE_PUBLIC_SUPABASE_URL: `${ORIGIN}/sb`,
        VITE_PUBLIC_ANON_KEY: ANON,
      },
    },
  ],
});
