// 设置子页返回 提醒接线代码复审第二轮 N1、L7 的真浏览器验证（jsdom 没有 View Transition）。R-487 起浏览器历史只有一条，返回栈在 history.state.lemoStack：
// • N1：直接打开提醒二级页 → 未来 7 天 → “‹ 提醒与通知” → “‹ 设置”：一层一层回，不跳层，浏览器历史一条都不多（原来的“浏览器后退再前进”没有了）
// • L7：快速连点“提醒与通知”入口（切换动画还没完）：只压一层，“‹ 设置”一次就回到设置首页
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const stack = (page: Page): Promise<unknown[]> => page.evaluate(() => (history.state as { lemoStack?: unknown[] } | null)?.lemoStack ?? []);
/** 直接打开某一页（像推送、书签那样没有返回栈）：原地换地址再派 hashchange，不让浏览器多压一条 */
async function openDirect(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    history.replaceState(null, '', h);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, hash);
}

test.describe('设置子页返回（复审第二轮 N1、L7）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

  test('N1：直接打开的二级页 → 三层页 → 一层一层返回，不跳层、历史不多', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today').waitFor({ timeout: 30000 });
    const len = await page.evaluate(() => history.length);
    await openDirect(page, '#/settings/remind');
    await page.getByTestId('remind-open-upcoming').click({ timeout: 30000 });
    await expect(page).toHaveURL(/#\/settings\/remind\/upcoming$/);
    expect(await stack(page)).toEqual(['#/settings/remind']);
    // 等整页过渡播完再点：新页画出来之前屏幕停在旧页上，这时的点按会被吞掉（motion/page-swap.ts holdScreen）
    await page.locator('html:not([data-vt])').waitFor({ state: 'attached' });
    await page.getByTestId('settings-remind-up-back').click();
    await expect(page).toHaveURL(/#\/settings\/remind$/);
    await expect(page.getByTestId('settings-reminders')).toBeVisible();
    await page.getByTestId('settings-remind-back').click();
    await expect(page).toHaveURL(/#\/settings$/);
    expect(await stack(page)).toEqual([]);
    expect(await page.evaluate(() => history.length)).toBe(len);
  });

  test('L7：快速连点入口只压一层', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today').waitFor({ timeout: 30000 });
    await openDirect(page, '#/settings');
    const entry = page.getByTestId('settings-remind-entry');
    await entry.waitFor({ timeout: 30000 });
    const len = await page.evaluate(() => history.length);
    // 两下之间不等切换画完（View Transition 约 380 ms）
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="settings-remind-entry"]');
      el?.click();
      el?.click();
    });
    await expect(page).toHaveURL(/#\/settings\/remind$/);
    await page.getByTestId('settings-reminders').waitFor();
    expect(await stack(page)).toEqual(['#/settings']);
    expect(await page.evaluate(() => history.length)).toBe(len);
    await page.getByTestId('settings-remind-back').click();
    await expect(page).toHaveURL(/#\/settings$/);
    expect(await stack(page)).toEqual([]);
  });
});
