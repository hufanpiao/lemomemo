// 四个主页面从屏幕左右两边往里划切页签（负责人 11-18：“在今天，日历，待办，随手记的主页面时左滑，右滑可以互相切换页面”；
// “4个页面切换只在退回到主页面时来回切”：二级页不切；“划到最左（今天）或最右（随手记）就循环”；“切页的触发区域只在左右两边就行”）。src/app/tab-swipe.ts。
// Chromium 用 CDP 发真的触摸（浏览器自己按顺序派 pointer 和 touch 事件，验证 data-hdrag 在 touchstart 之前就打上了）；
// 方向（负责人 11-18“今天页左滑切到日历，再左滑切到待办……一直循环”，负责人说的“左滑”是从左边起手往右划）：左边带往右划去下一个；
// 右边带往左划进设置（负责人 11-19“主页面右侧滑动默认进入设置页”“左滑切页不变”），设置首页左边带往右划退回（11-19“设置页左滑不返回到桌面”）。
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

test('左边往右划：今天 → 日历 → 待办 → 随手记 → 今天（循环）；中间划不切；主页面互切不压历史；右边往左划进设置、设置左边往右划退回原页', async ({ page, browserName }) => {
  await ready(page, '/app/#/today');
  const len0 = await page.evaluate(() => history.length);
  for (const r of ['calendar', 'todos', 'notes', 'today']) {
    await swipe(page, browserName, L, 300, 160);
    await at(page, r);
    await page.waitForTimeout(700);
  }
  for (const r of ['calendar', 'todos']) {
    await swipe(page, browserName, L, 300, 160);
    await at(page, r);
    await page.waitForTimeout(700);
  }
  await swipe(page, browserName, 300, 300, -160);
  await page.waitForTimeout(600);
  await at(page, 'todos');
  // 右边那条往右划（方向不对）不动
  await swipe(page, browserName, R, 300, 5);
  await page.waitForTimeout(400);
  await at(page, 'todos');
  // 主页面互切一条历史都不压（负责人 11-18：系统左边缘返回会抢在切页前面把页面退回今天，preview.416 t=26.38→26.43）
  expect(await page.evaluate(() => history.length)).toBe(len0);
  // 右边往左划：进设置，压一条历史；设置首页左边往右划：退回待办
  await swipe(page, browserName, R, 300, -160);
  await at(page, 'settings');
  expect(await page.evaluate(() => history.length)).toBe(len0 + 1);
  await page.waitForTimeout(700);
  await swipe(page, browserName, R, 300, -160);
  await page.waitForTimeout(500);
  await at(page, 'settings');
  await swipe(page, browserName, L, 300, 160);
  await at(page, 'todos');
});

test('月历中间划是翻月、不切页；翻过月的月历右边起手往左划进设置；直接打开的设置页左边往右划原地换回今天（不退出 App）', async ({ page, browserName }) => {
  await ready(page, '/app/#/calendar');
  const grid = await page.getByTestId('cal-pager').boundingBox();
  if (!grid) throw new Error('找不到月历');
  const month = await page.getByTestId('cal-title').textContent();
  await swipe(page, browserName, 300, grid.y + 120, -200);
  await page.waitForTimeout(800);
  await expect(page, '还在日历（翻月是 #/cal/month/…），没切去待办').toHaveURL(/#\/cal/);
  await expect(page.getByTestId('cal-title'), '翻到了下个月').not.toHaveText(month ?? '');
  await swipe(page, browserName, R, grid.y + 120, -160);
  await at(page, 'settings');
  await page.goto('/app/#/settings');
  await page.locator('main').first().waitFor();
  await page.waitForTimeout(500);
  await swipe(page, browserName, L, 300, 160);
  await at(page, 'today');
});

/** 右边那条按下以后，系统“前进”手势接管：浏览器前进一步，iPhone 再送 touchcancel（ended=cancel）或照常送 touchend（ended=end） */
async function edgeForward(page: Page, ended: 'cancel' | 'end'): Promise<void> {
  await page.evaluate(
    async ([x, ended]) => {
      const t = document.elementFromPoint(x, 300);
      if (!t) throw new Error('起点没有元素');
      const tch = (type: string, cx: number, done: boolean): void => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        const p = { clientX: cx, clientY: 300 };
        Object.defineProperty(e, 'touches', { value: done ? [] : [p] });
        Object.defineProperty(e, 'changedTouches', { value: [p] });
        t.dispatchEvent(e);
      };
      tch('touchstart', x, false);
      if (ended === 'cancel') tch('touchcancel', x - 20, true);
      await new Promise<void>((r) => {
        window.addEventListener('popstate', () => r(), { once: true });
        history.forward();
      });
      if (ended === 'end') tch('touchend', x - 160, true);
    },
    [R, ended] as const,
  );
}

for (const ended of ['cancel', 'end'] as const) {
  test(`负责人 11-19：从二级页退回主页面后右边往左划，系统“前进”抢先把页面带回二级页——原地换成设置（iPhone 送 ${ended === 'cancel' ? 'touchcancel、没有抬手' : '抬手'}）`, async ({ page }) => {
    await ready(page, '/app/#/todos');
    await page.evaluate(() => {
      location.hash = '#/settings/calendar';
    });
    await at(page, 'settings/calendar');
    // 那个二级页独有的小标题（设置首页没有 h2“节假日”；下面查“前进”途中它一帧都没画出来过）
    const sub = page.locator('main[data-feature="settings"] h2').first();
    await expect(sub).toBeVisible();
    const subTitle = (await sub.textContent())?.trim() ?? '';
    expect(subTitle).not.toBe('');
    await page.goBack();
    await at(page, 'todos');
    await page.waitForTimeout(700);
    // 负责人 11-19 晚录屏“右滑进设置的时候会闪之前的待办页”：从这一刻起每次 DOM 变化都记下页面上的 h1、h2，前进途中不许出现二级页的标题
    await page.evaluate(() => {
      const w = window as unknown as { seenH1: string[] };
      w.seenH1 = [];
      new MutationObserver(() => {
        for (const h of document.querySelectorAll('h1,h2')) w.seenH1.push((h.textContent ?? '').trim());
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await edgeForward(page, ended);
    await at(page, 'settings');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).toMatch(new RegExp(`tabswipe side=r to=settings fwd=1 how=${ended === 'cancel' ? 'pop cancel=1' : '(pop|up) cancel=0'} at=0`));
    // popstate 当下就换成设置（how=pop）的，二级页一帧都不画；抬手才知道（how=up，地址早已变）的那种照旧先画再换
    const log = await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
    if (/fwd=1 how=pop/.test(log)) expect(await page.evaluate(() => (window as unknown as { seenH1: string[] }).seenH1)).not.toContain(subTitle);
    // 原地换的：再退一步回到待办页（不是退回那个二级页、也没多压一层）
    await page.goBack();
    await at(page, 'todos');
  });

  // 负责人 11-19 傍晚“设置页自动闪退”（录屏 5d9ca61a）：从设置退回主页面后右边往左划，系统“前进”带回来的本来就是设置首页——照收，停在设置不再退回
  test(`负责人 11-19：“前进”带回来的就是设置首页时停在设置、不闪退（iPhone 送 ${ended === 'cancel' ? 'touchcancel' : '抬手'}）`, async ({ page }) => {
    await ready(page, '/app/#/todos');
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    await at(page, 'settings');
    await page.goBack();
    await at(page, 'todos');
    await page.waitForTimeout(700);
    await edgeForward(page, ended);
    await at(page, 'settings');
    await page.waitForTimeout(1200);
    await at(page, 'settings');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).toMatch(/tabswipe side=r to=settings fwd=1 how=\w+ cancel=\d at=1/);
  });
}
