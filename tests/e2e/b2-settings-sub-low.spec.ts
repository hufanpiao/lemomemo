// 设置子页返回 提醒接线代码复审第二轮 N1、L7 的真浏览器验证（jsdom 没有 View Transition，前进后退的事件次序也不一样）
// • N1：直接打开提醒二级页 → 未来 7 天 → 浏览器后退 → “‹ 设置” → 浏览器前进 → “‹ 提醒与通知”：回到二级页，不跳到首页，历史不叠
// • L7：快速连点“提醒与通知”入口（切换动画还没完）：只压一条历史，后退一次就回到设置首页
import { expect, test } from './session-fixture.ts';

test.describe('设置子页返回（复审第二轮 N1、L7）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

  test('N1：上一条被换成首页以后，从三层页点返回回到二级页', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today').waitFor({ timeout: 30000 });
    await page.evaluate(() => {
      window.location.hash = '#/settings/remind';
    });
    await page.getByTestId('remind-open-upcoming').click({ timeout: 30000 });
    await expect(page).toHaveURL(/#\/settings\/remind\/upcoming$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings\/remind$/);
    await page.getByTestId('settings-remind-back').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.goForward();
    await expect(page).toHaveURL(/#\/settings\/remind\/upcoming$/);
    const len = await page.evaluate(() => history.length);
    await page.getByTestId('settings-remind-up-back').click();
    await expect(page).toHaveURL(/#\/settings\/remind$/);
    await expect(page.getByTestId('settings-reminders')).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(len);
    await page.getByTestId('settings-remind-back').click();
    await expect(page).toHaveURL(/#\/settings$/);
    // 没有叠出两条“设置”：再后退一次就回到今天
    await page.goBack();
    await expect(page).toHaveURL(/#\/today$/);
  });

  test('L7：快速连点入口只压一条历史', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today').waitFor({ timeout: 30000 });
    await page.evaluate(() => {
      window.location.hash = '#/settings';
    });
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
    expect(await page.evaluate(() => history.length)).toBe(len + 1);
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings$/);
  });
});
