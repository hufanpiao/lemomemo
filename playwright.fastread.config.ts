// Playwright 快读组（B2 FA-6 ①，安全审查 L5）：带 supabase 地址的 e2e 构建。跑的用例：tests/e2e/e2e-config.ts 的 FASTREAD_ONLY_SPECS
// （R-402 插图上传、B5 隐私记、B4b-1 附件、B4b-2 查找和识图状态、B4b-3 “＋”助手：要 /sb 地址、会话令牌或同步引擎）加上两组都跑的
// b2-first-screen-supabase.spec.ts（这一组验快读分支）。
// 默认的假后端组（playwright.config.ts）构建时没配 VITE_PUBLIC_SUPABASE_URL，启动关口的快读分支跑不到；这一组把地址配成同源 /sb、
// anon key 用假值 FAKE_ANON_KEY（tests/e2e/fake-values.ts，一看就是假的，不是密钥）
// 和默认组、真后端组能同时跑：服务 8791、产物 dist/web-fastread、假后端 9193、9192、wrangler 状态 .wrangler/state-e2e-fastread、调试端口 9233
// 其余（CSP fixture、产物指纹 globalSetup、本机复用规则、看门狗）和默认组一样，骨架在 tests/e2e/e2e-config.ts
import { defineConfig } from '@playwright/test';
import { reuseServers } from './tools/e2e/reuse-servers.mjs';
import { DESKTOP_AND_PHONE, FASTREAD_ONLY_SPECS, e2eConfig } from './tests/e2e/e2e-config.ts';
import { FAKE_ANON_KEY, FAKE_PORT_ENV, fakePorts, type FakePorts } from './tests/e2e/fake-values.ts';

const PORT = 8791;
const FASTREAD_FAKE_PORTS: FakePorts = { s3: 9193, supabase: 9192 };
// 构建（webServer 里的 npm run build）、产物指纹（globalSetup）、用例（核对 apikey）都从环境变量读，所以在这里设好；
// 子进程和测试 worker 都继承。一律强制设置（安全复审 L7）：本机 shell 里有真实的地址、anon key 也不沿用，这一组只连本机假值
process.env['LEMO_WEB_OUT'] = 'dist/web-fastread';
process.env['LEMO_WS_PORT'] = String(PORT);
process.env['VITE_PUBLIC_SUPABASE_URL'] = `http://127.0.0.1:${PORT}/sb`;
process.env['VITE_PUBLIC_ANON_KEY'] = FAKE_ANON_KEY;

export default defineConfig({
  ...e2eConfig({
    port: PORT,
    state: '.wrangler/state-e2e-fastread',
    inspector: 9233,
    fake: fakePorts(process.env, FASTREAD_FAKE_PORTS),
    // 默认不复用，设了 LEMO_E2E_REUSE=1 才复用（tools/e2e/reuse-servers.mjs）；改了假后端端口一律不复用
    reuse: reuseServers(process.env) && !(process.env[FAKE_PORT_ENV.s3] || process.env[FAKE_PORT_ENV.supabase]),
    report: 'playwright-report-fastread',
  }),
  testMatch: ['**/b2-first-screen-supabase.spec.ts', ...FASTREAD_ONLY_SPECS],
  projects: DESKTOP_AND_PHONE,
});
