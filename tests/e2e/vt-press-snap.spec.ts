// UI-4 B1 动效确认 C3（X-3）：切页前所有 Pressable 瞬间复位（motion 的 transition() 打 data-snap），
// 拷旧页副本时没有缩着、正在弹回的按钮；换新页之前真页面上的摘掉。
// 11-20 起整页推页不用 View Transition（motion/page-swap.ts）：旧页是一份真 DOM 副本，副本里的 data-snap 整段留着
// （副本抄了 data-state，摘了按下的按钮会缩回 0.97），所以这里看副本挂上那一刻：副本里的都带 data-snap、算出来没有缩放，真页面上的已摘掉
import { waitPreloaded } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

// 合卡以后（SETTINGS-merge-cards）注销入口在账号二级页
const SETTINGS = '/app/#/settings/account';

// 手机宽度：电脑宽屏（1024 起）设置里换层只换右边详情、不起整页推页（负责人 11-25，web-layout.spec.ts ⑧），没有旧页副本可看
test.use({ loggedIn: true, viewport: { width: 390, height: 844 } });

test('旧页副本里的 Pressable 都带 data-snap、没有缩着（瞬间复位），真页面上的换页前已摘掉（C3）', async ({ page }) => {
  await page.goto(SETTINGS);
  await expect(page.getByTestId('settings-delete-entry')).toBeVisible({ timeout: 10_000 });
  // 推页动画实现首屏画完才下载，到之前换页直接换、不拷副本（motion/index.ts）：等冷启动预加载跑完，它早就到了
  await waitPreloaded(page);

  const seen = await page.evaluate(async () => {
    const rec = { copies: -1, snapped: 0, pressed: 0, scaled: 0, real: -1 };
    const mo = new MutationObserver(() => {
      const g = document.querySelector('[data-tab-ghost]');
      if (!g || rec.copies >= 0) return;
      const ps = [...g.querySelectorAll<HTMLElement>('[data-pressable]')];
      rec.copies = ps.length;
      rec.snapped = ps.filter((p) => p.hasAttribute('data-snap')).length;
      rec.pressed = ps.filter((p) => p.getAttribute('data-state') === 'pressed').length;
      // 计算样式：带 data-snap 的立刻是原大小（不等过渡），按着的那个也是
      rec.scaled = ps.filter((p) => getComputedStyle(p).transform !== 'none').length;
      rec.real = [...document.querySelectorAll('[data-snap]')].filter((e) => !e.closest('[data-tab-ghost], [data-swap-bar-copy]')).length;
    });
    mo.observe(document.body, { childList: true, subtree: true });
    const entry = document.querySelector<HTMLElement>('[data-testid="settings-delete-entry"]');
    entry?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    // 还按着就点（pointerup 前的 click）：副本拷到的是按下状态的按钮
    entry?.click();
    entry?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    // 按时间等、不按帧数等：CI 的 webkit 开着模糊一秒只出 1～3 帧，数 60 帧会拖过用例超时（副本是同步挂上的，正常一下就到）
    for (const t0 = performance.now(); rec.copies < 0 && performance.now() - t0 < 5000; ) await new Promise((r) => setTimeout(r, 20));
    mo.disconnect();
    return rec;
  });
  expect(seen.copies).toBeGreaterThan(0);
  expect(seen.snapped).toBe(seen.copies);
  expect(seen.scaled).toBe(0);
  expect(seen.real, '真页面上的换页前已摘掉').toBe(0);
  await expect(page.getByTestId('settings-delete')).toBeVisible();
});
