// 设置 › 皮肤（ADR-008；R-06、R-20、R-84、R-93）在真浏览器里：<html> 上的 data-skin、data-theme、data-rt 跟着选择改；
// 跟随系统时随 prefers-color-scheme 切换；重新打开 App 时按本机缓存先套上（不先闪一下默认皮肤）；登录页按同一份缓存
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const attr = (page: Page, name: string) => page.evaluate((n) => document.documentElement.getAttribute(n), name);

test.describe('皮肤与深浅色', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'zh-CN', colorScheme: 'dark' });

  test('默认简洁、跟着系统（系统深色 → dark，系统切浅色 → light）', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today').waitFor({ timeout: 30000 });
    await expect.poll(() => attr(page, 'data-theme')).toBe('dark');
    expect(await attr(page, 'data-skin')).toBe('simple');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => attr(page, 'data-theme')).toBe('light');
  });

  test('选磨砂玻璃、白天，开减少透明效果：马上换；重新打开先按缓存套上；登录页同样', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today').waitFor({ timeout: 30000 });
    await page.evaluate(() => {
      window.location.hash = '#/settings';
    });
    await page.getByTestId('settings-skin-entry').click({ timeout: 30000 });
    await expect(page).toHaveURL(/#\/settings\/skin$/);
    // 原生 radio 视觉隐藏、整行是 label：点 label
    await page.locator('label', { has: page.getByTestId('settings-skin-glass') }).click();
    await expect.poll(() => attr(page, 'data-skin')).toBe('glass');
    await page.locator('label', { has: page.getByTestId('settings-theme-light') }).click();
    await expect.poll(() => attr(page, 'data-theme')).toBe('light');
    await page.getByTestId('settings-skin-back').click();
    await expect(page.getByTestId('settings-skin-summary')).toHaveText('磨砂玻璃 · 白天');
    await page.getByTestId('settings-rt').click();
    await expect.poll(() => attr(page, 'data-rt')).toBe('1');

    await page.reload();
    await page.getByTestId('settings-skin-summary').waitFor({ timeout: 30000 });
    expect(await attr(page, 'data-skin')).toBe('glass');
    expect(await attr(page, 'data-theme')).toBe('light');
    expect(await attr(page, 'data-rt')).toBe('1');

    await page.goto('/app/auth/');
    await expect.poll(() => attr(page, 'data-skin')).toBe('glass');
    expect(await attr(page, 'data-theme')).toBe('light');
  });
});
