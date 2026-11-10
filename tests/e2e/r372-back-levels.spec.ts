// R-372（负责人 11-10“整体往左滑应该是返回上一个层级，不是返回上一个操作啊！！”）：真浏览器里点底栏、翻月、进设置，
// 再真后退（page.goBack，和 iPhone 左边缘侧滑同一条历史）。① 其他页签左滑回今天；② 日历里翻月算同一层；设置“‹ 今天”退一步不新压
// K6 起 /app/ 没有会话就跳 /app/auth/：整个文件用 session-fixture 写假会话
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true });

const len = (page: Page): Promise<number> => page.evaluate(() => history.length);
const tab = (page: Page, name: string) => page.locator(`[data-testid="tabbar"] a[data-tab="${name}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('/app/#/today');
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
});

test('今天 → 日历 → 待办 → 随手记：只压一条，后退一步回今天', async ({ page }) => {
  const base = await len(page);
  for (const name of ['calendar', 'todos', 'notes']) {
    await tab(page, name).click();
    await expect(page).toHaveURL(new RegExp(`#/${name}$`));
    await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
  }
  expect(await len(page)).toBe(base + 1);
  await page.goBack();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
});

test('日历翻 3 个月：后退一步回今天', async ({ page }) => {
  const base = await len(page);
  await tab(page, 'calendar').click();
  await expect(page.getByTestId('cal-next')).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByTestId('cal-next').click();
  await expect(page).toHaveURL(/#\/cal\/month\//);
  expect(await len(page)).toBe(base + 1);
  await page.goBack();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
});

test.describe('头像进设置', () => {
  // 头像只在手机宽度的今天页上有（宽屏设置入口在侧栏）：桌面 Chromium 也按手机宽度跑
  test.use({ viewport: { width: 440, height: 956 } });
  test('头像进设置，“‹ 今天”退一步回今天，不新压', async ({ page }) => {
    const base = await len(page);
    await page.getByTestId('today-settings').click();
    await expect(page.locator('main[data-feature="settings"]')).toBeVisible();
    expect(await len(page)).toBe(base + 1);
    await page.locator(`main[data-feature="settings"] header a[href="#/today"]`).click();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
    expect(await len(page)).toBe(base + 1);
    // 退回来以后前进还能回设置：说明是退了一步，不是又压了一条今天
    await page.goForward();
    await expect(page.locator('main[data-feature="settings"]')).toBeVisible();
  });
});
