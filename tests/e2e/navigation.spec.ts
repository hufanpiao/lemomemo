// UI-4 第二轮 N-5（B1 接手清单 M3）：真的浏览器后退（page.goBack()），不是单测里 replaceState + 手动派 hashchange。
// 确认后退只起一次整页切换，而且动画开始时 DOM 已经是上一页（不会把旧页面当新页滑进来）。
// 11-20 起整页切换不用 View Transition（motion/page-swap.ts）：用 addInitScript 在页面脚本之前包住 setAttribute，数 <html data-vt> 打了几次，
// 并包住 Element.prototype.animate，记下整页推页（关键帧里带 vw 的平移）第一次起动画时显示着的 main 的 data-feature
// K6 起 /app/ 没有会话就跳 /app/auth/：整个文件用 session-fixture 写假会话
import { expect, test } from './session-fixture.ts';

declare global {
  interface Window {
    __vt?: { calls: number; seen: (string | null)[] };
  }
}

test.use({ loggedIn: true });

test('真后退（page.goBack）：只起一次整页切换，动画开始时已经画完上一页', async ({ page }) => {
  await page.addInitScript(() => {
    const rec = { calls: 0, seen: [] as (string | null)[] };
    window.__vt = rec;
    // 包原型、不挂 MutationObserver：chromium 里注入脚本挂在早期文档上的观察者、监听后来都收不到（11-20 实测，页面里后挂的照常收到），原型上的包装一直在
    // 每次新打上 data-vt 算一次切换，并重新等这一次的第一段整页平移
    let started = false;
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (this === document.documentElement && name === 'data-vt' && !this.hasAttribute('data-vt')) {
        rec.calls += 1;
        started = false;
      }
      set.call(this, name, value);
    };
    const orig = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, opts?: number | KeyframeAnimationOptions) {
      const page = Array.isArray(frames) && frames.some((k) => String(k['translate'] ?? '').includes('vw'));
      if (page && document.documentElement.hasAttribute('data-vt') && !started) {
        started = true;
        rec.seen.push(document.querySelector('main')?.getAttribute('data-feature') ?? null);
      }
      return orig.call(this, frames, opts);
    };
  });

  await page.goto('/app/#/today');
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();

  // 改 hash 走一条真历史（浏览器派 hashchange，等同点页面里的链接）。去日程新建页不去日历：四个页签之间互切不起整页推页（负责人 11-06 方案 B，
  // tests/e2e/b2-tabbar-transition.spec.ts）；也不去设置、最近删除：电脑宽屏进出它们同页签互切原地淡换（负责人 11-25，web-layout.spec.ts ⑧）
  await page.evaluate(() => {
    location.hash = '#/event/new';
  });
  await expect(page.getByTestId('event-edit')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-vt', /.*/);
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
  await expect(page.locator('html')).not.toHaveAttribute('data-vt', /.*/);

  const vt = await page.evaluate(() => window.__vt);
  const touch = await page.evaluate(() => matchMedia('(hover: none)').matches);
  if (touch) {
    // 手机：系统边缘手势已经自己播了截图滑进来，不再补整页过渡（负责人 11-20“右滑进设置页会跳一下画面”，router.ts onPopState）
    expect(vt?.calls).toBe(0);
  } else {
    expect(vt?.calls).toBe(1);
    expect(vt?.seen).toEqual(['today']);
  }
});
