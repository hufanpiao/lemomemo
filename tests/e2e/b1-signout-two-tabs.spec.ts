// 两个标签页的退出（K9 退出流程签字条件之一；登录页审查）：一页开着主 App（已登录、本机库已建），
// 另一页在登录页点“退出并换账号”。断言：
//   ① 最后 indexedDB.databases() 里没有 planner-v4（主 App 页收到会话没了：设闸、清库、关本页连接、按库名删库；
//      登录页那边的删库也不再被主 App 的连接挡住）
//   ② 主 App 页回到登录页
//   ③ 没有无限重新载入（主 App 页落到登录页以后不再导航）
// 会话用 page.evaluate 写一次，不用 addInitScript：后者每次导航都会把会话写回去，退出就测不出来了。
// webkit 项目默认是 iPhone，登录页只给教程：这里统一换成桌面 Safari 的 UA、不带触屏，两个浏览器都点真按钮。
// e2e 构建拿不到 supabase-js（没配 VITE_PUBLIC_SUPABASE_URL），服务器退出不是 ok，走兜底清本机会话那条路（同 auth.spec.ts）。
// CSP 违规由 csp-fixture 自动检查（只看夹具自带的 page；第二页另外收集）
import type { Page } from '@playwright/test';
import { expect, fakeSessionJson, sessionKeyFor, test } from './session-fixture.ts';

const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

test.use({ userAgent: MAC_SAFARI_UA, hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });

const FAKE_TURNSTILE = `window.turnstile = { render(el, o) { setTimeout(() => o.callback && o.callback('XXXX.DUMMY.TOKEN.XXXX'), 0); return 'w1'; }, reset() {}, remove() {} };`;

async function fakeTurnstile(page: Page): Promise<void> {
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE }),
  );
}

const dbNames = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));

test('另一页“退出并换账号”：主 App 页清掉并删掉本机库、回登录页、不无限重新载入', async ({ page, context, baseURL }) => {
  await fakeTurnstile(page);
  // 写一次会话（同源的登录页上写），再开主 App：本机库建好、今天页画出来
  await page.goto('/app/auth/');
  const key = sessionKeyFor(new URL('/sb', baseURL ?? 'http://127.0.0.1:8788').href);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, fakeSessionJson()] as const);
  await page.goto('/app/');
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
  await expect.poll(() => dbNames(page)).toContain('planner-v4');

  // 主 App 页的导航计数（落到登录页以后不该再动）
  let navs = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navs++;
  });

  // 第二页：登录页显示“已登录”，点“退出并换账号”
  const other = await context.newPage();
  const violations: string[] = [];
  other.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await fakeTurnstile(other);
  await other.goto('/app/auth/');
  await expect(other.getByTestId('auth-signed-in')).toHaveText('当前已登录，要换账号请先退出');
  await other.getByRole('button', { name: '退出并换账号' }).click();
  await expect(other.locator('#auth-email')).toBeVisible({ timeout: 15_000 });

  // ② 主 App 页回到登录页
  await expect(page).toHaveURL(/\/app\/auth\/$/, { timeout: 15_000 });
  // ① 两边都看不到 planner-v4
  await expect.poll(() => dbNames(other), { timeout: 10_000 }).not.toContain('planner-v4');
  expect(await dbNames(page)).not.toContain('planner-v4');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /^sb-.+-auth-token$/.test(k)))).toEqual([]);

  // ③ 落到登录页以后等 3 秒：不再导航（没有 versionchange → 重新载入的循环）
  const settled = navs;
  await page.waitForTimeout(3000);
  expect(navs).toBe(settled);
  expect(navs).toBeLessThanOrEqual(2);
  await expect(page.locator('main[data-feature="today"]')).toHaveCount(0);
  expect(violations).toEqual([]);
  await other.close();
});
