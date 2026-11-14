// Playwright 默认组（架构 8.3）：chromium + webkit，服务用 wrangler pages dev dist/web 起（带 _headers 的 CSP 和 Pages Functions）
// 先按 e2e 模式构建（connect-src 里的 ws 指向本机 8788），再用项目里的 wrangler（devDependency）起服务；四组共用的骨架在 tests/e2e/e2e-config.ts
// /files、/sb 函数的环境变量用 --binding 指向本机假后端（tests/e2e/fake-backends.ts：S3 替身 + 假 Supabase；值全是假的，见 fake-values.ts）
// 和真后端组（playwright.real.config.ts）能同时跑（接手清单 E2E-parallel，R-267 D1）：假后端默认 9199、9198（真后端组 9197、9196），
// 产物 dist/web（真后端组 dist/web-real；设了 LEMO_WEB_OUT 按 build_web 同一条规则改，构建和 wrangler 用同一个目录），
// wrangler 本地状态 .wrangler/state-e2e、调试端口 9230（真后端组 state-e2e-real、9231）
// globalTimeout 默认 20 分钟，E2E_GLOBAL_TIMEOUT_MS 可改（tests/e2e/global-timeout.ts，E2E-webkit-hang）
import { defineConfig } from '@playwright/test';
import { reuseServers } from './tools/e2e/reuse-servers.mjs';
import { DESKTOP_AND_PHONE, FASTREAD_ONLY_SPECS, e2eConfig } from './tests/e2e/e2e-config.ts';
import { DEFAULT_FAKE_PORTS, FAKE_PORT_ENV, fakePorts } from './tests/e2e/fake-values.ts';

// 默认组不接 supabase（第三方审查 CI-6）：shell 里留着这两个变量时清掉，免得构建编进地址
delete process.env['VITE_PUBLIC_SUPABASE_URL'];
delete process.env['VITE_PUBLIC_ANON_KEY'];
/**
 * 默认不复用已经在跑的假后端和 wrangler；本机设了 LEMO_E2E_REUSE=1 才复用（CI 一律不复用，见 tools/e2e/reuse-servers.mjs，11-04 起）。
 * 设了 LEMO_E2E_FAKE_S3_PORT 或 LEMO_E2E_FAKE_SB_PORT 时一律不复用：
 * 8788 上那个旧 wrangler 的 binding 还指着默认的 9199、9198，复用了等于端口覆盖没生效（审查建议，10-30）
 * 复用时不重新构建，也不管 8788 上跑的是哪份产物：globalSetup（tests/e2e/dist-fingerprint.ts）先拿服务上的 /app/ 首页和本机
 * <产物目录>/app/index.html 逐字比对（引的都是带哈希的文件名，等于产物指纹），对不上直接失败。
 * ⚠ 仍查不出：服务和本机是同一份 dist、但 dist 比 src 旧——改了 src 要先 npm run build -- --mode e2e，或关掉 8788 上的服务（E2E-guard-sugg2 ④）
 */
const FAKE_PORTS_OVERRIDDEN = Boolean(process.env[FAKE_PORT_ENV.s3] || process.env[FAKE_PORT_ENV.supabase]);

export default defineConfig({
  ...e2eConfig({
    port: 8788,
    state: '.wrangler/state-e2e',
    inspector: 9230,
    fake: fakePorts(process.env, DEFAULT_FAKE_PORTS),
    reuse: reuseServers(process.env) && !FAKE_PORTS_OVERRIDDEN,
  }),
  // 只认 *.spec.ts；tests/e2e/*.preview.test.ts 是 Vitest 跑的预览环境用例（B0 集成）
  testMatch: '**/*.spec.ts',
  // *.real.spec.ts 是真后端那组（playwright.real.config.ts，npm run e2e:real）；tests/e2e/visual/ 是视觉组（playwright.visual.config.ts）；
  // FASTREAD_ONLY_SPECS 只在快读组（playwright.fastread.config.ts）跑。这一组都不跑
  testIgnore: ['**/*.real.spec.ts', '**/visual/**', ...FASTREAD_ONLY_SPECS],
  projects: DESKTOP_AND_PHONE,
});
