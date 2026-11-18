// 四个主页面从屏幕左右两边往里划切页签（负责人 11-18：“在今天，日历，待办，随手记的主页面时左滑，右滑可以互相切换页面”；
// “4个页面切换只在退回到主页面时来回切”：二级页不切；“划到最左（今天）或最右（随手记）就循环”；“切页的触发区域只在左右两边就行”）。src/app/tab-swipe.ts。
// Chromium 用 CDP 发真的触摸（浏览器自己按顺序派 pointer 和 touch 事件，验证 data-hdrag 在 touchstart 之前就打上了）；
// WebKit 没有 CDP，按真机的顺序（pointerdown 先、touchstart 后）在页面里派一遍
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';
import { waitPreloaded } from './page-helpers.ts';

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, locale: 'zh-CN', hasTouch: true });

async function swipe(page: Page, browser: string, x: number, y: number, dx: number): Promise<void> {
  if (browser === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 8, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  await page.evaluate(
    ([x, y, dx]) => {
      const t = document.elementFromPoint(x, y);
      if (!t) throw new Error('起点没有元素');
      const ptr = (type: string, cx: number): void =>
        void t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
      const tch = (type: string, cx: number, ended: boolean): void => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        const p = { clientX: cx, clientY: y };
        Object.defineProperty(e, 'touches', { value: ended ? [] : [p] });
        Object.defineProperty(e, 'changedTouches', { value: [p] });
        t.dispatchEvent(e);
      };
      ptr('pointerdown', x);
      tch('touchstart', x, false);
      for (let i = 1; i <= 8; i++) ptr('pointermove', x + (dx * i) / 8);
      ptr('pointerup', x + dx);
      tch('touchend', x + dx, true);
    },
    [x, y, dx] as const,
  );
}

const at = (page: Page, route: string) => expect(page).toHaveURL(new RegExp(`#/${route}$`), { timeout: 5000 });
/** 右边那条切页带、左边那条切页带里的起手 x（视口 430 宽，带宽 32） */
const R = 420;
const L = 10;

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await waitPreloaded(page);
  // 首屏画完以后才挂横滑：等一会儿再划
  await page.waitForTimeout(500);
}

test('右边往左划：今天 → 日历 → 待办 → 随手记 → 今天（循环）；左边往右划：今天 → 随手记 → 待办；中间划不切', async ({ page, browserName }) => {
  await ready(page, '/app/#/today');
  for (const r of ['calendar', 'todos', 'notes', 'today']) {
    await swipe(page, browserName, R, 300, -160);
    await at(page, r);
    await page.waitForTimeout(700);
  }
  for (const r of ['notes', 'todos']) {
    await swipe(page, browserName, L, 300, 160);
    await at(page, r);
    await page.waitForTimeout(700);
  }
  await swipe(page, browserName, 300, 300, -160);
  await page.waitForTimeout(600);
  await at(page, 'todos');
  // 右边那条往右划（方向不对）不切
  await swipe(page, browserName, R, 300, 5);
  await page.waitForTimeout(400);
  await at(page, 'todos');
});

test('月历中间划是翻月、不切页；月历右边起手是切页；设置页不切', async ({ page, browserName }) => {
  await ready(page, '/app/#/calendar');
  const grid = await page.getByTestId('cal-pager').boundingBox();
  if (!grid) throw new Error('找不到月历');
  const month = await page.getByTestId('cal-title').textContent();
  await swipe(page, browserName, 300, grid.y + 120, -200);
  await page.waitForTimeout(800);
  await expect(page, '还在日历（翻月是 #/cal/month/…），没切去待办').toHaveURL(/#\/cal/);
  await expect(page.getByTestId('cal-title'), '翻到了下个月').not.toHaveText(month ?? '');
  await swipe(page, browserName, R, grid.y + 120, -160);
  await at(page, 'todos');
  await page.goto('/app/#/settings');
  await page.locator('main').first().waitFor();
  await page.waitForTimeout(500);
  await swipe(page, browserName, R, 300, -160);
  await page.waitForTimeout(600);
  await at(page, 'settings');
});
