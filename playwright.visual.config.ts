// Playwright 视觉基准组（负责人 11-06“UI 改动先自动验好再给我看”；对照 docs/06-测试/负责人观感要求清单.md 的 G1～G8）：
// 只跑 tests/e2e/visual/*.spec.ts，只用 webkit（手机：440×956、deviceScaleFactor 3、isMobile、hasTouch），simple 皮肤浅色、深色各一个项目。
// 每条用例两样东西：toHaveScreenshot 截图比对（抓“变了”）+ 像素断言（抓“不符合负责人原话”，更重要，见 tests/e2e/visual/pixels.ts）。
// 基准图放 tests/e2e/visual/__screenshots__/<平台>/…：Linux（CI）和 Windows（本机）字体、抗锯齿不同，按平台分开存，
// 只有 linux 那一份进仓库、CI 比对；本机 Windows 跑出来的 win32 那一份 .gitignore 忽略，只给自己看“改前改后”。
// 和别的组能同时跑：服务 8851（LEMO_VISUAL_PORT 可改，只许 8850～8859）、产物 dist/web-visual、wrangler 状态 .wrangler/state-e2e-visual、
// 调试端口 9291（LEMO_VISUAL_INSPECTOR 可改，只许 9290～9299）。
// 不起假后端：这一组的数据全写在 IndexedDB 里（visual-helpers.ts 的 seedTodos），/sb、/files 的 binding 指向 8858、8859 上没人听的端口，
// 页面万一去连也是马上失败，不会连到别的组的假后端。
import { relative } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { webOutDir } from './build/assemble_web.mjs';
import { reuseServers } from './tools/e2e/reuse-servers.mjs';
import { e2eBindings } from './tests/e2e/fake-values.ts';
import { NO_BACKEND_GLOBAL_TIMEOUT_MS, globalTimeoutMs } from './tests/e2e/global-timeout.ts';

function portIn(name: string, fallback: number, lo: number, hi: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} 必须是纯十进制端口号`);
  const p = Number(raw);
  if (p < lo || p > hi) throw new Error(`${name} 的端口 ${p} 不在 ${lo}～${hi} 之间`);
  return p;
}

const PORT = portIn('LEMO_VISUAL_PORT', 8851, 8850, 8859);
const INSPECTOR = portIn('LEMO_VISUAL_INSPECTOR', 9291, 9290, 9299);
// 构建（webServer 里的 npm run build）和产物指纹（globalSetup）都从环境变量读，一律强制设置（和快读组一样，不沿用 shell 里的值）
process.env['LEMO_WEB_OUT'] = 'dist/web-visual';
process.env['LEMO_WS_PORT'] = String(PORT);

const WEB_OUT = relative(import.meta.dirname, webOutDir(import.meta.dirname, process.env)).replaceAll('\\', '/');
const REUSE = reuseServers(process.env);
const BINDINGS = Object.entries(e2eBindings({ s3: 8858, supabase: 8859 }))
  .map(([k, v]) => `--binding ${k}=${v}`)
  .join(' ');

/** 手机视口：负责人的 iPhone 是 440×956 pt、3 倍屏；UA、触摸照 iPhone 15 的设定，只换尺寸 */
const PHONE = {
  ...devices['iPhone 15'],
  viewport: { width: 440, height: 956 },
  screen: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
  timezoneId: 'Asia/Seoul',
};

/** 底栏视觉锁定用：桌面 Chromium、375×812、2 倍屏（参照图的截法），不开触屏（参照图是桌面 Chromium 截的） */
const CHROMIUM_375 = {
  ...devices['Desktop Chrome'],
  viewport: { width: 375, height: 812 },
  screen: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
  timezoneId: 'Asia/Seoul',
};

/** B2-UI-b 视觉锁定用：桌面 Chromium、440×956（负责人 iPhone 的宽高）、2 倍屏，不开触屏（和底栏锁定同一种截法，只换尺寸） */
const CHROMIUM_440 = {
  ...devices['Desktop Chrome'],
  viewport: { width: 440, height: 956 },
  screen: { width: 440, height: 956 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
  timezoneId: 'Asia/Seoul',
};

export default defineConfig({
  testDir: 'tests/e2e/visual',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // 最多 4 个 worker（本机多组 e2e 同时跑时不抢太多 CPU；CI 上同样）
  workers: 4,
  globalTimeout: globalTimeoutMs(process.env, NO_BACKEND_GLOBAL_TIMEOUT_MS),
  globalSetup: './tests/e2e/dist-fingerprint.ts',
  forbidOnly: process.env.CI === 'true',
  // 视觉组不重试：截图、像素断言挂了就是挂了，重试一次碰巧过会把真问题藏掉
  retries: 0,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-visual' }]] : 'list',
  outputDir: 'test-results-visual',
  // 按平台分开存（{platform} = linux / win32 / darwin）
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFileName}/{projectName}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      // 截图比对只抓“变了”：同一平台上同一份代码应当逐像素一样，留一点抗锯齿余量
      maxDiffPixelRatio: 0.002,
      threshold: 0.15,
      // 不用 Playwright 的 caret: 'hide'、animations: 'disabled'：它们往页面插 <style>，会触发 CSP 违规（csp-fixture 判失败）；
      // 光标、动画由 visual-helpers.ts 的 freeze()、still() 用构造样式表和 Animation.finish() 处理
      caret: 'initial',
      animations: 'allow',
      scale: 'device',
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'webkit-simple-light', testIgnore: ['**/tabbar-lock.spec.ts', '**/b2-ui-b-lock.spec.ts', '**/g-plus-hold.spec.ts'], use: { ...PHONE, colorScheme: 'light' } },
    { name: 'webkit-simple-dark', testIgnore: ['**/tabbar-lock.spec.ts', '**/b2-ui-b-lock.spec.ts', '**/g-plus-hold.spec.ts'], use: { ...PHONE, colorScheme: 'dark' } },
    // 底栏视觉锁定（R-360、R-361；界面改动防返工规则第四条）：只用 Chromium——WebKit 不画 backdrop-filter，锁不住模糊。
    // 条件和参照图（docs/03-评审/B2/底栏透明度截图/底栏-11-07还原后-对照确认图.png 右列）一致：375×812、@2x、无安全区，四套皮肤在用例里切
    { name: 'chromium-tabbar-lock', testMatch: '**/tabbar-lock.spec.ts', use: { ...CHROMIUM_375 } },
    // B2-UI-b 视觉锁定（任务单 W4、V4：设置页按钮区域 0 像素差，R-276、R-277；W8：随手记占位页模拟 62pt 顶部安全区）：
    // 同底栏锁定用 Chromium（软件光栅化确定），440×956、@2x（负责人 iPhone 的宽高），简洁皮肤浅深在用例里切
    { name: 'chromium-b2uib-lock', testMatch: '**/b2-ui-b-lock.spec.ts', use: { ...CHROMIUM_440 } },
    // Q3 守门第 1 条（B3 FA-3，R-352 ④）：“＋”加按住事件后底栏、“＋”0 像素差。同 B2-UI-b 锁定用 Chromium、440×956、@2x；
    // 基准只在本机 win32 生成（取改之前的代码，用法见用例文件头），CI 不跑这一组
    { name: 'chromium-plus-hold', testMatch: '**/g-plus-hold.spec.ts', use: { ...CHROMIUM_440 } },
  ],
  webServer: [
    {
      command: `npm run build -- --mode e2e && npx wrangler pages dev ${WEB_OUT} --ip 127.0.0.1 --port ${PORT} --compatibility-date 2026-10-01 --persist-to .wrangler/state-e2e-visual --inspector-port ${INSPECTOR} ${BINDINGS}`,
      url: `http://127.0.0.1:${PORT}/app/`,
      reuseExistingServer: REUSE,
      timeout: 180_000,
      env: { WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? '' },
    },
  ],
});
