// 四个主页面从屏幕左右两边往里划切页签（负责人 11-18：“在今天，日历，待办，随手记的主页面时左滑，右滑可以互相切换页面”；
// “划到最左（今天）或最右（随手记）就循环”；“切页的触发区域只在左右两边就行”）。src/app/tab-swipe.ts。
// Chromium 用 CDP 发真的触摸（浏览器自己按顺序派 pointer 和 touch 事件，验证 data-hdrag 在 touchstart 之前就打上了）；
// 方向（负责人 11-18“今天页左滑切到日历，再左滑切到待办……一直循环”，负责人说的“左滑”是从左边起手往右划）：左边带往右划去下一个；
// 右边带往左划进设置（负责人 11-19“主页面右侧滑动默认进入设置页”“左滑切页不变”），设置首页左边带往右划退回（11-19“设置页左滑不返回到桌面”）。
// R-487（负责人 11-19“进入待办编辑后回待办，在右滑会闪一次之前的待办编辑！修了4次了”“右滑重写”）：App 不压浏览器历史，全程 history.length 不变；
// 二级页左边带往右划是 App 自己的返回。原来“系统前进抢走右滑”的两组用例删了：没有“前进”那一条，系统没东西可抢。
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
const len = (page: Page): Promise<number> => page.evaluate(() => history.length);
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

test('左边往右划：今天 → 日历 → 待办 → 随手记 → 今天（循环）；中间划不切；右边往左划进设置、设置左边往右划退回原页；浏览器历史一条都不多', async ({ page, browserName }) => {
  await ready(page, '/app/#/today');
  const len0 = await len(page);
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
  expect(await len(page)).toBe(len0);
  // 右边往左划：进设置，待办压进返回栈；设置首页左边往右划：退回待办
  await swipe(page, browserName, R, 300, -160);
  await at(page, 'settings');
  expect(await len(page)).toBe(len0);
  await page.waitForTimeout(700);
  await swipe(page, browserName, R, 300, -160);
  await page.waitForTimeout(500);
  await at(page, 'settings');
  await swipe(page, browserName, L, 300, 160);
  await at(page, 'todos');
  expect(await len(page)).toBe(len0);
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
  // 先离开再打开：同一地址的 goto 在 webkit 里只算页内跳转，返回栈（月历）还在，就不是“直接打开”了
  await page.goto('about:blank');
  await ready(page, '/app/#/settings');
  await swipe(page, browserName, L, 300, 160);
  await at(page, 'today');
});

test('负责人 11-19：待办 → 待办编辑 → 左边往右划回待办 → 右边往左划进设置：全程浏览器历史不多一条，进设置之前一帧都不画编辑页（R-487）', async ({ page, browserName }) => {
  await ready(page, '/app/#/todos');
  const len0 = await len(page);
  test.info().annotations.push({ type: '起始 history.length', description: String(len0) });
  // 打字条“展开编辑”进待办编辑页（带着字会自动保存，地址换成这一条的 id）
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-bar')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('type-input').fill('买牛奶');
  await page.getByTestId('type-bar').getByRole('button', { name: '展开编辑' }).click();
  const title = page.getByTestId('todo-edit-title');
  await expect(title).toHaveValue('买牛奶');
  await page.waitForTimeout(700);
  expect(await len(page)).toBe(len0);
  // 二级页左边往右划：App 自己返回（从输入框上起手也算，编辑页焦点在标题里）
  const box = await title.boundingBox();
  await swipe(page, browserName, L, box ? box.y + box.height / 2 : 300, 160);
  await at(page, 'todos');
  await expect(title).toHaveCount(0);
  await page.waitForTimeout(700);
  expect(await len(page)).toBe(len0);
  // 从这一刻起每次 DOM 变化、每一帧都记编辑页在不在
  await page.evaluate(() => {
    const w = window as unknown as { seenEdit: number };
    w.seenEdit = 0;
    const look = (): void => {
      if (document.querySelector('[data-testid="todo-edit-title"]')) w.seenEdit++;
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
    const tick = (): void => {
      look();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await swipe(page, browserName, R, 300, -160);
  await at(page, 'settings');
  await expect(page.locator('main[data-feature="settings"]')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as { seenEdit: number }).seenEdit), '进设置途中画出过编辑页').toBe(0);
  expect(await len(page)).toBe(len0);
  const log = await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  expect(log).toMatch(/tabswipe side=l .*to=back/);
  expect(log).toMatch(/tabswipe side=r .*to=settings/);
  expect(log).toMatch(/stack depth=1 hist=\d+/);
  // 设置首页左边往右划回到待办
  await swipe(page, browserName, L, 300, 160);
  await at(page, 'todos');
  expect(await len(page)).toBe(len0);
});

test('直接打开的待办编辑页（没有返回栈）：左边往右划回待办列表；弹层开着时不响应', async ({ page, browserName }) => {
  await ready(page, '/app/#/todo/new');
  await expect(page.getByTestId('todo-edit-title')).toBeVisible();
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.id = 'zz-layer';
    document.body.append(d);
  });
  await swipe(page, browserName, L, 400, 160);
  await page.waitForTimeout(600);
  await at(page, 'todo/new');
  await page.evaluate(() => document.getElementById('zz-layer')?.remove());
  await swipe(page, browserName, L, 400, 160);
  await at(page, 'todos');
});

// 负责人 11-20：“纪念日页面没办法左滑跟右滑”——纪念日列表显示底栏、归日历页签，原来主页面表里漏了它，两边划都被跳过（日志 skip=root / skip=shape）
test('纪念日列表：左边往右划去待办；右边往左划进设置', async ({ page, browserName }) => {
  await ready(page, '/app/#/anniv');
  await swipe(page, browserName, L, 400, 160);
  await at(page, 'todos');
  await page.goto('about:blank');
  await ready(page, '/app/#/anniv');
  await swipe(page, browserName, R, 400, -160);
  await at(page, 'settings');
});
