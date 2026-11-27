// R-372（负责人 11-10“整体往左滑应该是返回上一个层级，不是返回上一个操作啊！！”）：真浏览器里点底栏、翻月、进设置，
// 再点页面里的返回（R-487 起浏览器历史只有一条，返回栈在 history.state.lemoStack）。① 四个主页面互切一律原地换、不压历史（负责人 11-18 推翻原来的“其他页签左滑回今天”：
// “之前左滑是回到主页，4个页面切换只在退回到主页面时来回切”）；② 日历里翻月算同一层；设置“‹ 今天”退一步不新压
// K6 起 /app/ 没有会话就跳 /app/auth/：整个文件用 session-fixture 写假会话
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true });

const len = (page: Page): Promise<number> => page.evaluate(() => history.length);
const stack = (page: Page): Promise<unknown[]> => page.evaluate(() => (history.state as { lemoStack?: unknown[] } | null)?.lemoStack ?? []);
const tab = (page: Page, name: string) => page.locator(`[data-testid="tabbar"] a[data-tab="${name}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('/app/#/today');
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
});

test('今天 → 日历 → 待办 → 随手记 → 今天：一条都不压（负责人 11-18 主页面互切不压历史）', async ({ page }) => {
  const base = await len(page);
  for (const name of ['calendar', 'todos', 'notes', 'today']) {
    await tab(page, name).click();
    await expect(page).toHaveURL(new RegExp(`#/${name}$`));
    await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
    expect(await len(page), name).toBe(base);
  }
});

test('今天 → 日历 → 翻 3 个月：一条都不压（翻月同一层、页签互切原地换）', async ({ page }) => {
  const base = await len(page);
  await tab(page, 'calendar').click();
  await expect(page.getByTestId('cal-next')).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByTestId('cal-next').click();
  await expect(page).toHaveURL(/#\/cal\/month\//);
  expect(await len(page)).toBe(base);
});

test.describe('头像进设置', () => {
  // 头像只在手机宽度的今天页上有（宽屏设置入口在侧栏）：桌面 Chromium 也按手机宽度跑
  test.use({ viewport: { width: 440, height: 956 } });
  test('头像进设置，“‹ 今天”退一步回今天：今天压进返回栈、退回来弹掉，浏览器历史一条都不多（R-487）', async ({ page }) => {
    const base = await len(page);
    await page.getByTestId('today-settings').click();
    await expect(page.locator('main[data-feature="settings"]')).toBeVisible();
    expect(await len(page)).toBe(base);
    expect(await stack(page)).toEqual(['#/today']);
    await page.locator(`main[data-feature="settings"] header a[href="#/today"]`).click();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
    expect(await len(page)).toBe(base);
    expect(await stack(page)).toEqual([]);
  });
});
