// 登录页 /app/auth/（架构 15.6 第 4b 条、5.9；K4）：带真实响应头（wrangler pages dev + _headers）跑
// - Turnstile 的脚本用 page.route 换成本地假的（不连 Cloudflare，结果稳定）；地址仍是 https://challenges.cloudflare.com，
//   所以 CSP 照常检查它：登录页放行、主 App 拦（对照组）
// - TC-B1-17、R-225：iPhone Safari（webkit 项目就是 iPhone 15 的 UA、非 standalone）只给教程；iOS 的 Chrome、KakaoTalk、微信也只给教程并提示用 Safari；桌面 Chromium 能看到邮箱框；
//   模拟 standalone（navigator.standalone = true）能登录；iPadOS（Mac UA + maxTouchPoints=5）同 iPhone
import type { Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { seedFakeSession, test as sessionTest } from './session-fixture.ts';

const FAKE_TURNSTILE = `
  window.turnstile = {
    render(el, opts) {
      const f = document.createElement('div');
      f.dataset.fakeTurnstile = '1';
      el.append(f);
      setTimeout(() => opts.callback && opts.callback('XXXX.DUMMY.TOKEN.XXXX'), 0);
      return 'w1';
    },
    reset() {},
    remove() {},
  };
`;

async function fakeTurnstile(page: Page): Promise<string[]> {
  const hits: string[] = [];
  await page.route('https://challenges.cloudflare.com/**', (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE });
  });
  return hits;
}

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE_CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
const IPHONE_KAKAO_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 25.9.0';
const IPHONE_WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c2f) NetType/WIFI Language/zh_CN';
const IPAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

test.describe('登录页', () => {
  test('桌面浏览器：能看到邮箱框，Turnstile 从 challenges.cloudflare.com 加载，没有 CSP 报错（TC-B1-16 的页面一半）', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkit 项目是 iPhone，见下一条');
    const hits = await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(page.locator('main[data-feature="auth"][data-step="email"]')).toBeVisible();
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.locator('[data-fake-turnstile]')).toHaveCount(1);
    expect(hits.some((u) => u.includes('/turnstile/v0/api.js'))).toBe(true);
  });

  test('TC-B1-17：iPhone Safari（非主屏幕）只显示“添加到主屏幕”教程，不给登录，也不加载 Turnstile', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', '用 webkit 项目的 iPhone 15 UA');
    const hits = await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(page.getByTestId('auth-install-guide')).toBeVisible();
    await expect(page.locator('#auth-email')).toHaveCount(0);
    expect(hits).toEqual([]);
  });

  test('TC-B1-17：iPhone 主屏幕版（standalone）能登录', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', '用 webkit 项目的 iPhone 15 UA');
    await fakeTurnstile(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
    });
    await page.goto('/app/auth/');
    await expect(page.locator('#auth-email')).toBeVisible();
  });

  test('TC-B1-17：iPadOS Safari（Mac UA + maxTouchPoints=5）同 iPhone，只给教程；同一个 UA 没有触屏（Mac）能登录', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'Mac UA 用 webkit 跑');
    for (const [touch, guide] of [
      [5, true],
      [0, false],
    ] as const) {
      const ctx = await browser.newContext({ userAgent: IPAD_UA, hasTouch: touch > 0, isMobile: false, viewport: { width: 1024, height: 768 } });
      const page = await ctx.newPage();
      await fakeTurnstile(page);
      await page.addInitScript((n) => {
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => n });
      }, touch);
      await page.goto('/app/auth/');
      if (guide) await expect(page.getByTestId('auth-install-guide')).toBeVisible();
      else await expect(page.locator('#auth-email')).toBeVisible();
      await ctx.close();
    }
  });

  // R-225：iPhone、iPad 上不在主屏幕模式的一律只给教程，不是 Safari 时另提示“请在 Safari 里打开本页”
  for (const [name, ua] of [
    ['iOS Chrome（CriOS）', IPHONE_CHROME_UA],
    ['KakaoTalk 内置浏览器（KAKAOTALK）', IPHONE_KAKAO_UA],
    ['微信内置浏览器（MicroMessenger）', IPHONE_WECHAT_UA],
  ] as const) {
    test(`R-225：${name} 只给教程，提示用 Safari 打开，不加载 Turnstile`, async ({ browser, browserName }) => {
      test.skip(browserName !== 'webkit', '用 webkit 跑 iPhone');
      const ctx = await browser.newContext({ userAgent: ua, isMobile: true, hasTouch: true, viewport: { width: 393, height: 659 } });
      const page = await ctx.newPage();
      const hits = await fakeTurnstile(page);
      await page.goto('/app/auth/');
      await expect(page.getByTestId('auth-install-guide')).toBeVisible();
      await expect(page.getByTestId('auth-open-in-safari')).toBeVisible();
      await expect(page.locator('#auth-email')).toHaveCount(0);
      expect(hits).toEqual([]);
      await ctx.close();
    });
  }

  test('iPhone Safari 本身不出“请在 Safari 里打开本页”那一句', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', '用 webkit 项目的 iPhone 15 UA');
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(page.getByTestId('auth-install-guide')).toBeVisible();
    await expect(page.getByTestId('auth-open-in-safari')).toHaveCount(0);
  });

  test('桌面 Chrome UA 在 webkit 里也照常登录（电脑浏览器不拦）', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', '只需跑一次');
    const ctx = await browser.newContext({ userAgent: CHROME_UA, isMobile: false, hasTouch: false });
    const page = await ctx.newPage();
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(page.locator('#auth-email')).toBeVisible();
    await ctx.close();
  });

  // 安全审查必改 1：真 Turnstile 在真实 CSP 下跑通。不 mock api.js、不拦截请求，要连得上 challenges.cloudflare.com；
  // 本机构建没给站点密钥时用官方测试密钥（总是通过）；负责人建好预览的站点密钥后，在预览环境用同一条实测。
  // 没设 LEMO_REAL_TURNSTILE=1 就跳过（CI 和平时的本机跑都不连外网）
  test('真 Turnstile（LEMO_REAL_TURNSTILE=1）：小窗的 challenge 请求返回 200、拿得到令牌、没有 CSP 违规', async ({ page, csp, browserName }) => {
    test.skip(process.env['LEMO_REAL_TURNSTILE'] !== '1', '没设 LEMO_REAL_TURNSTILE=1：要连真的 challenges.cloudflare.com');
    test.skip(browserName !== 'chromium', 'webkit 项目是 iPhone，登录页只给教程、不加载 Turnstile');
    // 小窗的 iframe 放在 closed shadow root 里，选择器找不到它；改看它发出的 challenge-platform 请求（所有 frame 的响应都收得到）
    const challenge: number[] = [];
    page.on('response', (r) => {
      const u = r.url();
      if (u.startsWith('https://challenges.cloudflare.com/') && u.includes('/challenge-platform/')) challenge.push(r.status());
    });
    await page.goto('/app/auth/');
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect.poll(() => challenge.includes(200), { timeout: 20_000 }).toBe(true);
    // 拿到令牌时 Turnstile 把它写进小窗旁的隐藏输入框 cf-turnstile-response（在普通 DOM 里）
    await expect
      .poll(async () => page.locator('[data-testid="auth-captcha"] input[name="cf-turnstile-response"]').inputValue().catch(() => ''), {
        timeout: 30_000,
      })
      .not.toBe('');
    // 没有 CSP 违规：这里先查一遍给出明确结论，csp 夹具收尾时还会再查一遍（事件和控制台都看）
    expect(await csp.violations(), 'securitypolicyviolation 事件').toEqual([]);
    expect(csp.consoleErrors, '控制台 CSP 报错').toEqual([]);
  });

  test('对照组：主 App /app/ 里加载 Turnstile 的脚本会被 CSP 拦（15.6 第 4b 条：只有登录页放行）', async ({ page, csp, browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', '只需跑一次');
    csp.expectViolations();
    await fakeTurnstile(page);
    // K6 起 /app/ 没有会话就跳 /app/auth/：写假会话才能停在主 App（K16 共用夹具）
    await seedFakeSession(page.context(), baseURL);
    await page.goto('/app/');
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      document.head.append(s);
    });
    await expect.poll(async () => (await csp.violations()).length).toBeGreaterThan(0);
    const v = await csp.violations();
    expect(v.every((x) => x.directive.startsWith('script-src'))).toBe(true);
    expect(await page.evaluate(() => 'turnstile' in window)).toBe(false);
  });
});

// 架构 0.38 第 35 条、4.1：已登录时打开 /app/auth/ 先要求退出（loggedIn 夹具：页面脚本之前写入假的 supabase-js 会话）
// e2e 构建没配 VITE_PUBLIC_SUPABASE_URL，supabase-js 拿不到：服务器退出（删 devices 行、signOut）不是 ok，
// 正好走“兜底清本机会话”那条路；服务器那两步的顺序和参数由单测（auth-api.test.ts）守着
sessionTest.describe('已登录时打开登录页（0.38 第 35 条）', () => {
  sessionTest.use({ loggedIn: true });

  sessionTest('先说“当前已登录，要换账号请先退出”；“退出并换账号”清掉本机会话、本机库和缓存后才出登录表单', async ({ page, browserName }) => {
    sessionTest.skip(browserName !== 'chromium', 'webkit 项目是 iPhone，登录页只给教程');
    const hits = await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await expect(page.getByTestId('auth-signed-in')).toHaveText('当前已登录，要换账号请先退出');
    await expect(page.locator('#auth-email')).toHaveCount(0);
    expect(hits).toEqual([]);

    // 造一份本机库和一份 Cache Storage（库要先关掉，不然删库会被自己挡住）
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('planner-v4', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('meta');
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(r.error);
      });
      await (await caches.open('lemo-e2e')).put('/app/e2e-probe', new Response('x'));
    });

    await page.getByRole('button', { name: '退出并换账号' }).click();
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect.poll(() => hits.some((u) => u.includes('/turnstile/v0/api.js'))).toBe(true);
    const left = await page.evaluate(async () => ({
      sessionKeys: Object.keys(localStorage).filter((k) => /^sb-.+-auth-token$/.test(k)),
      dbs: (await indexedDB.databases()).map((d) => d.name),
      caches: await caches.keys(),
    }));
    expect(left.sessionKeys).toEqual([]);
    expect(left.dbs).not.toContain('planner-v4');
    expect(left.caches).toEqual([]);
  });

  sessionTest('“回到 App”回 /app/，不退出', async ({ page, browserName }) => {
    sessionTest.skip(browserName !== 'chromium', 'webkit 项目是 iPhone，登录页只给教程');
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await page.getByRole('button', { name: '回到 App' }).click();
    await expect(page).toHaveURL(/\/app\/$/);
    expect(await page.evaluate(() => Object.keys(localStorage).some((k) => /^sb-.+-auth-token$/.test(k)))).toBe(true);
  });
});
