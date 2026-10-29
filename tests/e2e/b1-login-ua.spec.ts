// B1 K16：网页登录 × 模拟 UA（测试用例 v4 第 4.1 节 TC-B1-16、TC-B1-17；架构“首次引导”一行、第 9 节端到端“网页登录（第七轮）”）
//
// 四种模拟环境（两个 project 各跑一遍：chromium 验判断逻辑，webkit 是离 iPhone 最近的引擎）：
//   iPhone Safari 非主屏幕：iPhone 15 的 UA、视口、触摸；navigator.standalone = false，display-mode 是 browser
//   iPhone 主屏幕版（standalone）：同上，再把 navigator.standalone 和 matchMedia('(display-mode: standalone)') 改成 true，视口换成整屏
//   iPadOS Safari：Mac Safari 的 UA（iPadOS 默认伪装成 Mac）＋ navigator.maxTouchPoints = 5，非主屏幕
//   桌面：chromium project 用 Desktop Chrome，webkit project 用 Desktop Safari（模拟 Mac Safari）
// 只模拟 JS 能读到的部分（UA、maxTouchPoints、navigator.standalone、matchMedia）；CSS 的 @media (display-mode) 不跟着变。
// App 的判断是 platform/env.installGate()（isAppleMobile、isStandalone、isIOSSafari；iPadOS 加 maxTouchPoints > 1；R-225），按这几个 JS 接口判断时模拟有效。
//
// 能跑的：每种环境的自检（模拟值真的生效、按判断式该分到“教程”还是“登录”）、/app/ 外壳在该环境下能打开且没有 CSP 报错、
//   登录页 /app/auth/（K4）上该出教程还是登录表单（TC-B1-16、TC-B1-17 的页面部分；R-225 起 iOS 上的 Chrome、KakaoTalk、微信也只给教程）。
// “能登录”那两条（原来 test.fixme 着：TC-B1-16 桌面走一遍网页登录、TC-B1-17 主屏幕版能登录）已搬到真后端组
//   tests/e2e/b1-login-ua.real.spec.ts（E2E-REAL 第 5 步，npm run e2e:real 跑；/sb 接 lemo-e2e、验证码从 Mailpit 取）。
// 模拟 UA 的函数、登录页的选择器在 tests/e2e/ua-emulation.ts（两组共用）。
import { expect, test } from './csp-fixture.ts';
import { DESKTOP_CHROME, IPHONE, MAC_SAFARI, TUTORIAL, emailBox, emulate, expectedGate, fakeTurnstile, readEnv } from './ua-emulation.ts';

// ───────── 各模拟环境 ─────────

test.describe('模拟 iPhone Safari（非主屏幕）', () => {
  test.use(IPHONE);
  test.beforeEach(async ({ page }) => emulate(page, 'iphone'));

  test('自检：UA 是 iPhone Safari、不是主屏幕版 → 按架构该只给教程', async ({ page }) => {
    await page.goto('/app/');
    // 没有会话时 /app/ 会 location.replace 到 /app/auth/：先等跳完再读，免得和跳转抢（Execution context was destroyed）
    await page.waitForURL('**/app/auth/**');
    const e = await readEnv(page);
    expect(e.ua).toMatch(/iPhone; CPU iPhone OS .* Version\/[\d.]+ Mobile\/\w+ Safari\//);
    expect(e.navStandalone).toBe(false);
    expect(e.displayStandalone).toBe(false);
    expect(expectedGate(e)).toBe('tutorial');
  });

  test('/app/ 外壳在 iPhone Safari 模拟下能打开，没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.locator('main[data-feature]')).toBeVisible();
  });

  test('TC-B1-17：打开登录页只显示“添加到主屏幕”教程，不给登录', async ({ page }) => {
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(page.getByText(TUTORIAL).first()).toBeVisible();
    await expect(emailBox(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /发送验证码|获取验证码|登录/ })).toHaveCount(0);
  });
});

test.describe('模拟 iPhone 主屏幕版（standalone）', () => {
  // 主屏幕版没有浏览器地址栏和工具栏，视口就是整屏
  test.use({ ...IPHONE, viewport: { width: 393, height: 852 } }); // iPhone 15 的整屏（CSS 像素）
  test.beforeEach(async ({ page }) => emulate(page, 'standalone'));

  test('自检：navigator.standalone 和 display-mode: standalone 都是 true → 按架构该能登录', async ({ page }) => {
    await page.goto('/app/');
    // 没有会话时 /app/ 会 location.replace 到 /app/auth/：先等跳完再读，免得和跳转抢（Execution context was destroyed）
    await page.waitForURL('**/app/auth/**');
    const e = await readEnv(page);
    expect(e.ua).toMatch(/iPhone/);
    expect(e.navStandalone).toBe(true);
    expect(e.displayStandalone).toBe(true);
    // 别的 display-mode 查询不受影响
    expect(await page.evaluate(() => window.matchMedia('(display-mode: browser)').matches)).toBe(false);
    expect(expectedGate(e)).toBe('login');
  });

  test('/app/ 外壳在主屏幕版模拟下能打开，没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.locator('main[data-feature]')).toBeVisible();
  });

  test('TC-B1-17：打开登录页显示登录表单、不显示教程', async ({ page }) => {
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(emailBox(page)).toBeVisible();
    await expect(page.getByText(TUTORIAL)).toHaveCount(0);
  });
});

test.describe('模拟 iPadOS Safari（Mac UA ＋ maxTouchPoints=5）', () => {
  test.use({ ...MAC_SAFARI, viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 });
  test.beforeEach(async ({ page }) => emulate(page, 'ipad'));

  test('自检：UA 是 Mac Safari、maxTouchPoints=5、非主屏幕 → 按架构该只给教程', async ({ page }) => {
    await page.goto('/app/');
    // 没有会话时 /app/ 会 location.replace 到 /app/auth/：先等跳完再读，免得和跳转抢（Execution context was destroyed）
    await page.waitForURL('**/app/auth/**');
    const e = await readEnv(page);
    expect(e.ua).toMatch(/Macintosh; Intel Mac OS X .* Version\/[\d.]+ Safari\//);
    expect(e.maxTouchPoints).toBe(5);
    expect(e.navStandalone).toBe(false);
    expect(e.displayStandalone).toBe(false);
    expect(expectedGate(e)).toBe('tutorial');
  });

  test('/app/ 外壳在 iPadOS Safari 模拟下能打开，没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.locator('main[data-feature]')).toBeVisible();
  });

  test('TC-B1-17：打开登录页只显示“添加到主屏幕”教程，不给登录', async ({ page }) => {
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(page.getByText(TUTORIAL).first()).toBeVisible();
    await expect(emailBox(page)).toHaveCount(0);
  });
});

test.describe('桌面（chromium：Desktop Chrome；webkit：Desktop Safari）', () => {
  const pick = (b: string) => (b === 'webkit' ? MAC_SAFARI : DESKTOP_CHROME);
  test.use({
    userAgent: async ({ browserName }, use) => use(pick(browserName).userAgent),
    viewport: async ({ browserName }, use) => use(pick(browserName).viewport),
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: async ({ browserName }, use) => use(pick(browserName).deviceScaleFactor),
  });
  test.beforeEach(async ({ page }) => emulate(page, 'desktop'));

  test('自检：桌面 UA、没有触摸 → 按架构照常登录（第七轮：电脑上的 Safari 不拦）', async ({ page, browserName }) => {
    await page.goto('/app/');
    // 没有会话时 /app/ 会 location.replace 到 /app/auth/：先等跳完再读，免得和跳转抢（Execution context was destroyed）
    await page.waitForURL('**/app/auth/**');
    const e = await readEnv(page);
    expect(e.ua).not.toMatch(/iPhone|iPad|iPod/);
    if (browserName === 'webkit') expect(e.ua).toMatch(/Macintosh.* Version\/[\d.]+ Safari\//);
    expect(e.maxTouchPoints).toBeLessThanOrEqual(1);
    expect(e.displayStandalone).toBe(false);
    expect(expectedGate(e)).toBe('login');
  });

  test('/app/ 外壳在桌面模拟下能打开，没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.locator('main[data-feature]')).toBeVisible();
  });

  test('TC-B1-16：打开登录页显示登录表单、不显示教程', async ({ page }) => {
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(emailBox(page)).toBeVisible();
    await expect(page.getByText(TUTORIAL)).toHaveCount(0);
  });
});

// R-225：iPhone 上不是 Safari 的浏览器（iOS 的 Chrome、KakaoTalk、微信内置浏览器），非主屏幕 → 只给教程，另提示用 Safari 打开
const IN_APP: readonly (readonly [string, string])[] = [
  [
    'iOS Chrome（CriOS）',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  ],
  [
    'KakaoTalk 内置浏览器（KAKAOTALK）',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 25.9.0',
  ],
  [
    '微信内置浏览器（MicroMessenger）',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c2f) NetType/WIFI Language/zh_CN',
  ],
];

for (const [name, ua] of IN_APP) {
  test.describe(`模拟 ${name}（非主屏幕，R-225）`, () => {
    test.use({ ...IPHONE, userAgent: ua });
    test.beforeEach(async ({ page }) => emulate(page, 'iphone'));

    test('自检：iPhone UA、不是 Safari、非主屏幕 → 只给教程并提示用 Safari', async ({ page }) => {
      await page.goto('/app/');
      // 没有会话时 /app/ 会 location.replace 到 /app/auth/：先等跳完再读，免得和跳转抢（Execution context was destroyed）
      await page.waitForURL('**/app/auth/**');
      const e = await readEnv(page);
      expect(e.ua).toBe(ua);
      expect(expectedGate(e)).toBe('tutorial-safari');
    });

    test('TC-B1-17 / R-225：打开登录页只显示教程和“请在 Safari 里打开本页”，不给登录', async ({ page }) => {
      await fakeTurnstile(page);
      await page.goto('/app/auth/');
      await expect(page.getByText(TUTORIAL).first()).toBeVisible();
      await expect(page.getByText(/请在 Safari 里打开本页/)).toBeVisible();
      await expect(emailBox(page)).toHaveCount(0);
      await expect(page.getByRole('button')).toHaveCount(0);
    });
  });
}
