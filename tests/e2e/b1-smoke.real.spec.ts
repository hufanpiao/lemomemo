// 真后端那组的冒烟（需求记录 R-255，接手清单 E2E-REAL 第 4 步）：npm run e2e:real 跑（playwright.real.config.ts），无后端组不跑
// 建账号（admin 接口 + 补 profiles 行）→ loginViaOtp（不发信，经 /sb 换会话写进 localStorage）→ 打开 /app/ →
// 页面能经同源 /sb 读到自己的 profiles 行（RLS 下只有这一行）；App 自己启动后也要进到已登录的外壳（不被踢回登录页）
import { expect, test } from './csp-fixture.ts';
import { createAccount, loginViaOtp, restInPage } from './real-backend.ts';

test('冒烟：建账号 → 免发信登录 → /app/ 经 /sb 读到自己的 profiles 行', async ({ page }) => {
  const acc = await createAccount();
  const session = await loginViaOtp(page, acc.email);
  expect(session.user.id).toBe(acc.userId);

  await page.goto('/app/');
  // 有会话：不跳登录页，进到 App 外壳（主界面或首次告知页都算）
  await expect(page.locator('main[data-feature]').first()).toBeVisible();
  expect(new URL(page.url()).pathname).not.toMatch(/^\/app\/auth\//);

  const r = await restInPage(page, 'GET', '/rest/v1/profiles?select=user_id,ui_locale');
  expect(r.status).toBe(200);
  expect(r.body).toEqual([{ user_id: acc.userId, ui_locale: 'zh-CN' }]);
});
