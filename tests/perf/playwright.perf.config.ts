// 性能测量组（第三方审查分诊表“前端-15”：今天页每行各挂错误边界、Suspense 和订阅，行多了慢不慢）：只跑 tests/perf/*.perf.ts；测量用 Chromium（要 CDP），动效逐帧对照另跑 webkit。
// 不进 CI、不进 npm 脚本，要量时手动跑：npx playwright test -c tests/perf/playwright.perf.config.ts
// 和其他组错开：服务 8796、假后端 9194/9195、调试端口 9236、产物 dist/web-perf、.wrangler/state-e2e-perf；一个 worker、不重试（量数时别的用例不抢 CPU）
// PERF_NOBUILD=1 时不重新构建；PERF_CPU=4 时 CDP 把 CPU 降速 4 倍再量（接近手机）；PERF_OUT 给一个文件路径时把三次的原始数据写成 JSON
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { e2eConfig } from '../e2e/e2e-config.ts';
import type { FakePorts } from '../e2e/fake-values.ts';

const PORT = 8796;
const PERF_FAKE_PORTS: FakePorts = { s3: 9194, supabase: 9195 };
process.env['LEMO_WEB_OUT'] = 'dist/web-perf';
process.env['LEMO_WS_PORT'] = String(PORT);
delete process.env['VITE_PUBLIC_SUPABASE_URL'];
delete process.env['VITE_PUBLIC_ANON_KEY'];

const base = e2eConfig({ port: PORT, state: '.wrangler/state-e2e-perf', inspector: 9236, fake: PERF_FAKE_PORTS, reuse: false, report: 'playwright-report-perf',
  // PERF_NOBUILD=1：dist/web-perf 已经是这份源码构建的（连着量几遍时省掉重新构建）
  ...(process.env['PERF_NOBUILD'] === '1' ? { build: 'node -e 0' } : {}) });

// 这份配置不在仓库根：webServer 的命令（npm run build、node tests/e2e/fake-backends.ts、wrangler 的产物目录）按仓库根跑，globalSetup 也按这里改相对路径
const ROOT = join(import.meta.dirname, '..', '..');
const servers = [base.webServer ?? []].flat().map((s) => ({ ...s, cwd: ROOT }));

export default defineConfig({
  ...base,
  globalSetup: '../e2e/dist-fingerprint.ts',
  webServer: servers,
  testDir: '.',
  testMatch: '**/*.perf.ts',
  workers: 1,
  retries: 0,
  timeout: 300_000,
  use: { ...base.use, trace: 'off' },
  // 本机 Windows 上无头 Chromium 没有窗口，渲染进程会被当成后台降速（11-21 实测：帧与帧之间停 30～90 秒、一次 setInterval 记成 13 秒、载入等满 60 秒），
  // 量出来的是系统降速、不是页面。关掉后台降速、EcoQoS 和计时器节流
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-features=UseEcoQoSForBackgroundProcess,IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
          ],
        },
      },
    },
    // 动效逐帧对照（today-motion-frames.perf.ts）两种内核都要；测量和剖析只在 Chromium（要 CDP）
    { name: 'webkit', testMatch: '**/today-motion-frames.perf.ts', use: { ...devices['Desktop Safari'] } },
  ],
});
