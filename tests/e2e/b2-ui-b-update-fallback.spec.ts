// B2-UI-b W6（首屏瘦身安全审 S1，D3 ①）：“更新”拿不到 sw-lifecycle.ts 时的退路，真实浏览器里走一遍。
// 造法同 b1-cache-too-new：先在 /app/auth/ 用更高版本建 planner-v4，再开 /app/ 出整屏提示“去更新”；
// 整屏提示渲染前那次 registerSw（platform/sw-register.ts）就会去下载 sw-lifecycle-*.js，这里在网络层拦掉，复现“启动那次下载失败”。
// ① 原地址、换地址（?r=）都拦：两条退路都不行（没有 waiting 的新 SW）→ 显示新提示“…不行就完全关闭柠檬记再打开”，而且确实发过 ?r= 的请求；
// ② 只拦原地址：换地址那次拿到了模块（?r= 的请求 200、页面没有动态 import 报错）。这一页启动时没注册上 SW（启动那次下载被拦了），
//   拿到模块后 updateServiceWorker 照实回“没查成”，所以最后的文字仍是失败提示；这里只验证退路 ① 真的把模块拿到了
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true });

const LIFECYCLE = /\/app\/assets\/sw-lifecycle-[^/?]+\.js(\?.*)?$/;

async function openTooNew(page: Page): Promise<void> {
  await page.goto('/app/auth/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('planner-v4', 99);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('meta');
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(new Error(String(req.error)));
      }),
  );
  await page.goto('/app/');
  await expect(page.getByTestId('cache-too-new')).toBeVisible();
}

test('① 原地址、换地址都下载不到：回 failed，提示“完全关闭再重新打开”，换地址那次确实试过', async ({ page }) => {
  const seen: string[] = [];
  await page.route(LIFECYCLE, (route) => {
    seen.push(route.request().url());
    return route.abort();
  });
  await openTooNew(page);
  await page.getByTestId('cache-too-new').getByRole('button', { name: '去更新' }).click();
  await expect(page.getByTestId('cache-too-new').getByRole('status')).toHaveText('更新失败 · 联网后再试，不行就完全关闭柠檬记再打开', { timeout: 15_000 });
  expect(seen.some((u) => /\?r=\d+$/.test(u)), `拦到的请求：${seen.join(' ')}`).toBe(true);
  expect(seen.some((u) => !u.includes('?')), `拦到的请求：${seen.join(' ')}`).toBe(true);
});

test('② 只有原地址下载不到：换地址那次拿到模块（200），没有动态 import 报错', async ({ page }) => {
  const fresh: number[] = [];
  const importErrors: string[] = [];
  page.on('pageerror', (e) => importErrors.push(e.message));
  await page.route(LIFECYCLE, async (route) => {
    if (!route.request().url().includes('?r=')) return route.abort();
    const res = await route.fetch();
    fresh.push(res.status());
    return route.fulfill({ response: res });
  });
  await openTooNew(page);
  await page.getByTestId('cache-too-new').getByRole('button', { name: '去更新' }).click();
  await expect.poll(() => fresh, { timeout: 15_000 }).toContain(200);
  await expect(page.getByTestId('cache-too-new').getByRole('status')).toHaveText(/更新失败/, { timeout: 15_000 });
  expect(fresh).toHaveLength(1);
  expect(importErrors.filter((m) => /dynamically imported module|Importing a module script failed/.test(m))).toEqual([]);
});
