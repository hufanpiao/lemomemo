// B1 K16 网页登录的真后端部分（测试用例 v4 TC-B1-16、TC-B1-17；E2E-REAL 第 5 步，从 b1-login-ua.spec.ts 的 test.fixme 搬来）
// npm run e2e:real 跑（playwright.real.config.ts）：/sb 接 lemo-e2e，验证码真的发到 lemo-e2e 的 Mailpit 再取回来——
// 整个真后端组只有这两条走真发信（otpFromMailpit），别的用例一律 createAccount + loginViaOtp，不发信。
// 页面上“该出教程还是登录表单”、模拟值生效的自检仍在无后端组（b1-login-ua.spec.ts），这里只补“真的能登录”。
// 走一遍：邮箱 → 发验证码 → 输码（填满 6 位自动提交，没有“登录”按钮）→ 回到 App（首次登录先过告知页关口）。验证码不截图、不打印。
// Turnstile 换成假脚本；lemo-e2e 的 [auth.captcha] enabled = false（照仓库 config），假令牌不被校验。
// TC-B1-16 写的是“桌面 Chromium、桌面 WebKit”：真后端组默认只跑 chromium，E2E_REAL_WEBKIT=1 时多一个 webkit project（Desktop Safari）。
import { type Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { createAccount, otpFromMailpit, sessionKeyFor } from './real-backend.ts';
import { DESKTOP_CHROME, IPHONE, MAC_SAFARI, emailBox, emulate, fakeTurnstile } from './ua-emulation.ts';

/** 走一遍网页登录；返回本机会话里的 user_id（按 supabase-js 的键名读） */
async function loginViaPage(page: Page, email: string): Promise<string | null> {
  await fakeTurnstile(page);
  await page.goto('/app/auth/');
  await emailBox(page).fill(email);
  await page.getByRole('button', { name: '发验证码' }).click();
  const code = await otpFromMailpit(email);
  await page.getByRole('textbox', { name: '邮箱里的 6 位验证码' }).fill(code);
  await expect(page).toHaveURL(/\/app\/(#\/.*)?$/);
  await expect(page.locator('main[data-feature]').first()).toBeVisible();
  const key = sessionKeyFor(new URL('/sb', page.url()).href);
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null) : null;
  }, key);
}

test.describe('TC-B1-16 桌面（chromium：Desktop Chrome；webkit：Desktop Safari）', () => {
  const pick = (b: string) => (b === 'webkit' ? MAC_SAFARI : DESKTOP_CHROME);
  test.use({
    userAgent: async ({ browserName }, use) => use(pick(browserName).userAgent),
    viewport: async ({ browserName }, use) => use(pick(browserName).viewport),
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: async ({ browserName }, use) => use(pick(browserName).deviceScaleFactor),
  });
  test.beforeEach(async ({ page }) => emulate(page, 'desktop'));

  test('走一遍网页登录（验证码真的发到 Mailpit）：能登录，会话归这个账号，不跳回登录页', async ({ page }) => {
    const acc = await createAccount();
    expect(await loginViaPage(page, acc.email)).toBe(acc.userId);
    expect(new URL(page.url()).pathname).not.toMatch(/^\/app\/auth\//);
  });
});

test.describe('TC-B1-17 模拟 iPhone 主屏幕版（standalone）', () => {
  test.use({ ...IPHONE, viewport: { width: 393, height: 852 } }); // iPhone 15 的整屏（CSS 像素）
  test.beforeEach(async ({ page }) => emulate(page, 'standalone'));

  test('主屏幕版能登录（验证码真的发到 Mailpit）：会话归这个账号，不跳回登录页', async ({ page }) => {
    const acc = await createAccount();
    expect(await loginViaPage(page, acc.email)).toBe(acc.userId);
    expect(new URL(page.url()).pathname).not.toMatch(/^\/app\/auth\//);
  });
});
