// Playwright（架构 8.3）：chromium + webkit，服务用 wrangler pages dev dist/web 起（带 _headers 的 CSP 和 Pages Functions）
// 先按 e2e 模式构建（connect-src 里的 ws 指向本机 8788），再用项目里的 wrangler（devDependency）起服务
import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;

export default defineConfig({
  testDir: 'tests/e2e',
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
  webServer: {
    command: `npm run build -- --mode e2e && npx wrangler pages dev dist/web --ip 127.0.0.1 --port ${PORT} --compatibility-date 2026-10-01`,
    url: `http://127.0.0.1:${PORT}/app/`,
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 180_000,
    env: { WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? '' },
  },
});
