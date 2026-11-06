// UI-4 B1 动效确认 C3（X-3）：切页前所有 Pressable 瞬间复位（motion 的 transition() 打 data-snap），
// 浏览器截旧画面时没有缩着、正在弹回的按钮；进了 View Transition 的回调就摘掉。
// （C2“过渡期间点按不被吞”B2 试过 ::view-transition { pointer-events: none; }：Chromium、WebKit 过渡期间命中的一律是 <html>，
//  加了也一样，没有效果，已撤掉；怎么处理待负责人定，见前端 A 第 8 行回报）
import { expect, test } from './session-fixture.ts';

// 合卡以后（SETTINGS-merge-cards）注销入口在账号二级页
const SETTINGS = '/app/#/settings/account';

test.use({ loggedIn: true });

test('起过渡那一刻页面上的 Pressable 都带 data-snap（瞬间复位、不截到缩着的按钮），过渡回调里已摘掉（C3）', async ({ page }) => {
  await page.goto(SETTINGS);
  await expect(page.getByTestId('settings-delete-entry')).toBeVisible();
  const supported = await page.evaluate(() => 'startViewTransition' in document);
  test.skip(!supported, '这个浏览器不支持 View Transitions');

  const seen = await page.evaluate(async () => {
    const d = document as unknown as { startViewTransition: (cb: () => void) => { finished: Promise<void> } };
    const orig = d.startViewTransition.bind(d);
    const rec = { atStart: { pressables: 0, snapped: 0, scaled: 0 }, inCallback: -1 };
    d.startViewTransition = (cb) => {
      const ps = [...document.querySelectorAll<HTMLElement>('[data-pressable]')];
      rec.atStart.pressables = ps.length;
      rec.atStart.snapped = ps.filter((p) => p.hasAttribute('data-snap')).length;
      // 计算样式：带 data-snap 的立刻是原大小（不等过渡）
      rec.atStart.scaled = ps.filter((p) => getComputedStyle(p).transform !== 'none').length;
      // cb 是 motion 的回调：先摘 data-snap、再画新页面；它返回后数一下（新页面上的 Pressable 也不带）
      return orig(() => {
        cb();
        rec.inCallback = document.querySelectorAll('[data-snap]').length;
      });
    };
    const entry = document.querySelector<HTMLElement>('[data-testid="settings-delete-entry"]');
    entry?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    entry?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    entry?.click();
    for (let i = 0; i < 60 && rec.inCallback < 0; i++) await new Promise((r) => requestAnimationFrame(r));
    return rec;
  });
  expect(seen.atStart.pressables).toBeGreaterThan(0);
  expect(seen.atStart.snapped).toBe(seen.atStart.pressables);
  expect(seen.atStart.scaled).toBe(0);
  expect(seen.inCallback).toBe(0);
  await expect(page.getByTestId('settings-delete')).toBeVisible();
});
