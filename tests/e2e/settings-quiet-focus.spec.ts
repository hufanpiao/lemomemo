// 设置二级页退回首页以后，焦点放回进来时点的那一行（读屏接着读），但手指操作时不画焦点框（负责人 11-18 截图“还有这个框是什么东西”：
// 手指点返回以后“日历”那一行套了个白框，iOS Safari 把程序放的焦点也算 :focus-visible）。键盘操作照旧画框。
// 改法见 src/features/settings/ui/SettingsSub.tsx 的 quietFocus 和 src/styles/base.css 的 [data-quiet-focus]
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, locale: 'zh-CN', hasTouch: true });

/** 那一行此刻画出来的焦点框：outline 宽度（px）和样式 */
const ring = (page: Page) =>
  page.getByTestId('settings-cal-entry').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { focused: document.activeElement === el, quiet: el.hasAttribute('data-quiet-focus'), w: parseFloat(cs.outlineWidth) || 0, style: cs.outlineStyle };
  });

test('手指点进“日历”再点返回：焦点回到那一行，但不画焦点框', async ({ page }) => {
  await page.goto('/app/#/settings');
  await page.getByTestId('settings-cal-entry').tap();
  await page.getByTestId('settings-cal-back').tap();
  await expect.poll(async () => (await ring(page)).focused, { timeout: 5000 }).toBe(true);
  const r = await ring(page);
  expect(r.quiet, '手指操作带 data-quiet-focus').toBe(true);
  expect(r.style === 'none' || r.w === 0, `不画框（outline ${r.style} ${r.w}px）`).toBe(true);
  // 注意：电脑上的 Chromium、WebKit 摘掉标记也不画框（11-18 实测），负责人截图里的白框只在 iPhone 上有；这条只守住“手指不画、键盘照画”，白框消没消要真机看
});

test('键盘进“日历”再按返回：焦点回到那一行，照旧画焦点框', async ({ page }) => {
  await page.goto('/app/#/settings');
  await page.getByTestId('settings-cal-entry').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('settings-cal-back').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await ring(page)).focused, { timeout: 5000 }).toBe(true);
  const r = await ring(page);
  expect(r.quiet, '键盘操作不带 data-quiet-focus').toBe(false);
  expect(r.style !== 'none' && r.w > 0, `画框（outline ${r.style} ${r.w}px）`).toBe(true);
});
