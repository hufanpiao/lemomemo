// UI-4 第二轮 N-5（B1 接手清单 M3）：真的浏览器后退（page.goBack()），不是单测里 replaceState + 手动派 hashchange。
// 确认后退只起一个 View Transition，而且回调一返回 DOM 已经是上一页（浏览器截“新画面”不会截到旧页面）。
// 用 addInitScript 在页面脚本之前包住 document.startViewTransition：记次数、记回调返回时的 data-feature
// K6 起 /app/ 没有会话就跳 /app/auth/：整个文件用 session-fixture 写假会话
import { expect, test } from './session-fixture.ts';

declare global {
  interface Window {
    __vt?: { calls: number; seen: (string | null)[]; supported: boolean };
  }
}

test.use({ loggedIn: true });

test('真后退（page.goBack）：只起一个 View Transition，回调里已经画完上一页', async ({ page }) => {
  await page.addInitScript(() => {
    const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const orig = d.startViewTransition?.bind(d);
    window.__vt = { calls: 0, seen: [], supported: orig !== undefined };
    if (!orig) return;
    d.startViewTransition = (cb: () => void) => {
      const rec = window.__vt;
      if (rec) rec.calls += 1;
      return orig(() => {
        cb();
        rec?.seen.push(document.querySelector('main')?.getAttribute('data-feature') ?? null);
      });
    };
  });

  await page.goto('/app/#/today');
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();

  // 改 hash 走一条真历史（浏览器派 hashchange，等同点页面里的链接）
  await page.evaluate(() => {
    location.hash = '#/calendar';
  });
  await expect(page.locator('main[data-feature="calendar"]')).toBeVisible();
  await page.evaluate(() => {
    const rec = window.__vt;
    if (rec) {
      rec.calls = 0;
      rec.seen = [];
    }
  });

  await page.goBack();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();

  const vt = await page.evaluate(() => window.__vt);
  if (vt?.supported) {
    expect(vt.calls).toBe(1);
    expect(vt.seen).toEqual(['today']);
  } else {
    // 浏览器不支持 View Transitions：直接切换，不报错就行
    expect(vt?.calls).toBe(0);
  }
});
