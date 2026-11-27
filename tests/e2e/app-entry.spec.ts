// K6 新入口（src/app/main.tsx；架构 4.1、0.38 第 17 条）：/app/ 读不到本机会话的 user_id 就直接跳 /app/auth/，不渲染今天页。
// 其他用例为了打开 App 页面都写了假会话（tests/e2e/session-fixture.ts），这里守住反方向：不带会话、会话不对时一定跳登录页；
// 再自检一次夹具写的会话 App 确实认。
import { expect, sessionKeyFor, test } from './session-fixture.ts';

test.describe('App 入口：没登录就去登录页', () => {
  test('不带会话打开 /app/：跳到 /app/auth/，不渲染今天页', async ({ page }) => {
    await page.goto('/app/');
    await expect(page).toHaveURL(/\/app\/auth\/$/);
    await expect(page.locator('main[data-feature="today"]')).toHaveCount(0);
  });

  test('不带会话直接打开某一页（/app/#/calendar）：同样跳到 /app/auth/', async ({ page }) => {
    await page.goto('/app/#/calendar');
    await expect(page).toHaveURL(/\/app\/auth\/$/);
    await expect(page.locator('main[data-feature]')).toHaveCount(0);
  });

  test("会话键在、但内容没有 uuid 的 user.id（原来官网用例写的 '{}'）：当成没登录，跳到 /app/auth/", async ({ page, baseURL }) => {
    const key = sessionKeyFor(new URL('/sb', baseURL ?? 'http://127.0.0.1:8788').href);
    await page.context().addInitScript(
      ([k, v]) => {
        try {
          localStorage.setItem(k, v);
        } catch {
          // 不透明来源没有 localStorage
        }
      },
      [key, JSON.stringify({ user: { id: 'not-a-uuid' } })] as const,
    );
    await page.goto('/app/');
    await expect(page).toHaveURL(/\/app\/auth\/$/);
    await expect(page.locator('main[data-feature="today"]')).toHaveCount(0);
  });
});

test.describe('夹具自检：带假会话', () => {
  test.use({ loggedIn: true });

  test('打开 /app/ 停在 App，今天页画出来；会话键名照 sessionStorageKey 的取法', async ({ page, baseURL }) => {
    await page.goto('/app/');
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
    await expect(page).toHaveURL(/\/app\/(#\/today)?$/);
    const key = sessionKeyFor(new URL('/sb', baseURL ?? 'http://127.0.0.1:8788').href);
    expect(key).toBe(`sb-${new URL(baseURL ?? 'http://127.0.0.1:8788').hostname.split('.')[0]}-auth-token`);
    expect(await page.evaluate((k) => localStorage.getItem(k) !== null, key)).toBe(true);
  });
});
