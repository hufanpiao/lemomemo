// B1 K16 网页登录的真后端部分（测试用例 v4 TC-B1-16、TC-B1-17；E2E-REAL 第 5 步，从 b1-login-ua.spec.ts 的 test.fixme 搬来）
// npm run e2e:real 跑（playwright.real.config.ts）：/sb 接 lemo-e2e，验证码真的发到 lemo-e2e 的 Mailpit 再取回来——
// 整个真后端组只有这两条走真发信（otpFromMailpit），别的用例一律 createAccount + loginViaOtp，不发信。
// 页面上“该出教程还是登录表单”、模拟值生效的自检仍在无后端组（b1-login-ua.spec.ts），这里只补“真的能登录”。
// 走一遍：邮箱 → 发验证码 → 输码（填满 6 位自动提交，没有“登录”按钮）→ 回到 App（首次登录先过告知页关口）。验证码不截图、不打印。
// Turnstile 换成假脚本；lemo-e2e 的 [auth.captcha] enabled = false（照仓库 config），假令牌不被校验。
// TC-B1-16 写的是“桌面 Chromium、桌面 WebKit”：真后端组默认只跑 chromium，E2E_REAL_WEBKIT=1 时多一个 webkit project（Desktop Safari）。
import { type Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { REAL_ENV, assertLocalBackendUrl, createAccount, otpFromMailpit, sessionKeyFor } from './real-backend.ts';
import { DESKTOP_CHROME, IPHONE, MAC_SAFARI, emailBox, emulate, fakeTurnstile } from './ua-emulation.ts';

/** 填码后等跳回 App 的时间：第一次冷启动（wrangler 刚起、Functions 第一次编译）偶尔超过 5 秒（接手清单 E2E-flaky-ua） */
const AFTER_CODE_TIMEOUT = 15_000;
// 建账号 + 等信（最多 15 秒）+ 等跳转、等主界面（各最多 15 秒）会超过默认的 30 秒整条用例上限，这个文件放到 60 秒
test.describe.configure({ timeout: 60_000 });

/**
 * Mailpit 里给这个邮箱的信的到达时间（新到旧，和 otpFromMailpit 取第一封的顺序一样），只给失败报错用：
 * 判断是不是取错了信（比如取到的是上一次发的码）。只读时间和 ID 前 8 位，不读正文、不碰验证码
 */
async function mailpitTimes(email: string): Promise<string> {
  try {
    const base = assertLocalBackendUrl(process.env[REAL_ENV.mailpit] ?? '', REAL_ENV.mailpit);
    const r = await fetch(new URL(`/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, base));
    const j = (await r.json()) as { messages?: { ID: string; Created?: string }[] };
    const list = j.messages ?? [];
    if (!list.length) return '（一封也没有）';
    return list.map((m, i) => `${i === 0 ? '[取的这封] ' : ''}${m.Created ?? '（没有时间）'}（ID ${m.ID.slice(0, 8)}）`).join('、');
  } catch (e) {
    return `（取不到：${e instanceof Error ? e.message : String(e)}）`;
  }
}

/** 走一遍网页登录；返回本机会话里的 user_id（按 supabase-js 的键名读） */
async function loginViaPage(page: Page, email: string): Promise<string | null> {
  await fakeTurnstile(page);
  await page.goto('/app/auth/');
  await emailBox(page).fill(email);
  const sentAt = new Date().toISOString();
  await page.getByRole('button', { name: '发验证码' }).click();
  const code = await otpFromMailpit(email);
  const gotAt = new Date().toISOString();
  await page.getByRole('textbox', { name: '邮箱里的 6 位验证码' }).fill(code);
  try {
    await expect(page).toHaveURL(/\/app\/(#\/.*)?$/, { timeout: AFTER_CODE_TIMEOUT });
    await expect(page.locator('main[data-feature]').first()).toBeVisible({ timeout: AFTER_CODE_TIMEOUT });
  } catch (e) {
    const mails = await mailpitTimes(email);
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `填码后 ${AFTER_CODE_TIMEOUT / 1000} 秒内没回到 App（现在在 ${page.url()}）。` +
        `点“发验证码”：${sentAt}；取到验证码：${gotAt}；Mailpit 里给这个邮箱的信（新到旧）：${mails}\n${why}`,
    );
  }
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
