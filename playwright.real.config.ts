// Playwright 真后端那组（需求记录 R-255，接手清单 E2E-REAL）：只跑 tests/e2e/**/*.real.spec.ts，默认只跑 chromium
//
// 用法：npm run e2e:real:up → npm run e2e:real（先 real-backend.mjs check，再跑本配置）→ npm run e2e:real:down
// • 加载时用 tools/e2e/real-backend.mjs 的 statusEnv() 取 lemo-e2e（project_id，api 55321、Mailpit 55324）的地址和密钥；
//   后端没起就直接抛错，提示先跑 npm run e2e:real:up。取到的值只放进本进程的环境变量（worker 继承），不打印
// • webServer：先 node build/build_web.mjs --mode e2e-real 构建（VITE_PUBLIC_SUPABASE_URL = http://127.0.0.1:8789/sb、VITE_PUBLIC_ANON_KEY 由这里传入），
//   再用 wrangler pages dev 起 8789：/sb 的 SUPABASE_UPSTREAM 指 lemo-e2e 的 55321、SUPABASE_ANON_KEY 用取到的值，PROXY_SECRET 仍是假值；
//   /files 的 R2 照旧指假 S3（tests/e2e/fake-backends.ts；这组默认 9197，它顺带起的 9196 假 Supabase 这组用不到）
// • 能和无后端组同时跑（接手清单 E2E-parallel，R-267 D1）：假后端默认 9197、9196（REAL_GROUP_FAKE_PORTS，无后端组 9199、9198），
//   LEMO_E2E_FAKE_S3_PORT、LEMO_E2E_FAKE_SB_PORT 可改（9190～9199）；wrangler 本地状态 .wrangler/state-e2e-real、调试端口 9231（无后端组 state-e2e、9230）。
//   919x 只是假后端，不进 tests/e2e/real-backend.ts 的 ALLOWED_PORTS
// • reuseExistingServer 一律 false：8789、9197 被占着就直接失败，不会连上别人起的服务
// • globalTimeout（E2E-webkit-hang，R-267 D2）：只跑 chromium 默认 15 分钟，E2E_REAL_WEBKIT=1 时 30 分钟，E2E_GLOBAL_TIMEOUT_MS 可改（tests/e2e/global-timeout.ts）；
//   webkit 项目单独收紧：actionTimeout 15 秒、navigationTimeout 30 秒、workers 1（10-30 webkit 卡住、端口被残留进程占着）
// • 产物写 dist/web-real（LEMO_WEB_OUT，接手清单 E2E-dist），wrangler 也从那里起：和无后端组（playwright.config.ts，dist/web）互不覆盖；
//   CSP 的 ws 端口用 LEMO_WS_PORT 跟着 PORT 走
// • ⚠ 失败时留下的 trace（test-results/**/trace.zip，CI 的 html 报告里也有）含本地 lemo-e2e 的 anon key（请求头、页面里的构建配置）
//   和测试账号的会话令牌（localStorage、/sb 请求的 Authorization）。都是本地演示密钥和一次性测试账号，但 CI 上传报告、产物前要注意：
//   不要公开上传，或者上传前删掉 trace（真后端组不截图、不录屏，就是为了少带这些）
import { defineConfig, devices } from '@playwright/test';
import { FAKE_PORT_ENV, REAL_GROUP_FAKE_PORTS, e2eBindings, fakePorts } from './tests/e2e/fake-values.ts';
import { globalTimeoutMs, realGroupDefaultTimeoutMs } from './tests/e2e/global-timeout.ts';
import { REAL_ENV, assertE2eOrigins } from './tests/e2e/real-backend.ts';
import { statusEnv } from './tools/e2e/real-backend.mjs';

const PORT = 8789;
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** 本组的产物目录（不和无后端组的 dist/web 共用） */
const WEB_OUT = 'dist/web-real';
/** 本组的假后端端口（默认 9197、9196，不和无后端组的 9199、9198 抢） */
const FAKE = fakePorts(process.env, REAL_GROUP_FAKE_PORTS);

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
// 顺序不能变：先铺假后端那套，再用真上游覆盖 SUPABASE_UPSTREAM、SUPABASE_ANON_KEY
const BINDINGS = Object.entries({ ...e2eBindings(FAKE), SUPABASE_UPSTREAM: UPSTREAM, SUPABASE_ANON_KEY: ANON })
  .map(([k, v]) => `--binding ${k}=${v}`)
  .join(' ');

export default defineConfig({
  testDir: 'tests/e2e',
  // 输出目录和无后端组（默认 test-results/）分开：Playwright 开跑先清空输出目录，两组同时跑会删掉对方的 trace（E2E-parallel，10-31 实测 12 条 ENOENT）
  outputDir: 'test-results-real',
  testMatch: '**/*.real.spec.ts',
  // 同一个专用库、每条用例自己建账号，互不干扰；但 wrangler 只有一个，并发别太高
  fullyParallel: true,
  globalTimeout: globalTimeoutMs(process.env, realGroupDefaultTimeoutMs(process.env)),
  ...(process.env.CI === 'true' ? { workers: 2 } : {}),
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : 'list',
  // 失败时留 trace，但不截图、不录屏（页面里有会话令牌）
  use: { baseURL: ORIGIN, trace: 'retain-on-failure', screenshot: 'off', video: 'off' },
  // 默认只跑 chromium；E2E_REAL_WEBKIT=1 时多跑 webkit（TC-B1-16 要求桌面 WebKit 也走一遍网页登录）
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.E2E_REAL_WEBKIT === '1'
      ? [
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'], actionTimeout: 15_000, navigationTimeout: 30_000 },
            // webkit 一次只开一个 worker：10-30 并发时卡住过
            workers: 1,
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: 'node tests/e2e/fake-backends.ts',
      url: `http://127.0.0.1:${FAKE.supabase}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { [FAKE_PORT_ENV.s3]: String(FAKE.s3), [FAKE_PORT_ENV.supabase]: String(FAKE.supabase) },
    },
    {
      command: `node build/build_web.mjs --mode e2e-real && npx wrangler pages dev ${WEB_OUT} --ip 127.0.0.1 --port ${PORT} --compatibility-date 2026-10-01 --persist-to .wrangler/state-e2e-real --inspector-port 9231 ${BINDINGS}`,
      url: `${ORIGIN}/app/`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        WRANGLER_SEND_METRICS: 'false',
        CI: process.env.CI ?? '',
        VITE_PUBLIC_SUPABASE_URL: `${ORIGIN}/sb`,
        VITE_PUBLIC_ANON_KEY: ANON,
        LEMO_WEB_OUT: WEB_OUT,
        LEMO_WS_PORT: String(PORT),
      },
    },
  ],
});
