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
import { afterPageFade, readRunLogInPage, waitPreloaded } from './page-helpers.ts';
import { cached, idbPut } from './idb.ts';
import { logOnFail } from './fail-log.ts';

// 失败时带运行日志（tabswipe 那一行写着这一下是切了还是为什么没切：skip=shape 太短太斜太慢、skip=moved 等）
logOnFail(test);

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, locale: 'zh-CN', hasTouch: true });

async function swipe(page: Page, browser: string, x: number, y: number, dx: number): Promise<void> {
  if (browser === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    // 十个触摸事件按 STEP_MS 的真实时间间隔排进去（浏览器按顺序派），不一个一个等回执：每个 dispatchTouchEvent 要等页面处理完那一帧才回，
    // 一个一个等，这一下划多久就跟着帧率走（11-23 本机日志 tabswipe ms=284～434，CI 慢机过了 SWIPE_MAX_MS 500 ms 就判 skip=shape 不切，
    // CI 4ba84584 停在 #/calendar）。现在一下约 9 × STEP_MS ≈ 110 ms（手指划 160 px 的正常快慢），不由测试机的帧率定
    const STEP_MS = 12;
    const sent: Promise<unknown>[] = [];
    const points = [...Array.from({ length: 8 }, (_, k) => [{ x: x + (dx * (k + 1)) / 8, y }]), []];
    sent.push(cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }));
    for (const [k, touchPoints] of points.entries()) {
      await new Promise((r) => setTimeout(r, STEP_MS));
      sent.push(cdp.send('Input.dispatchTouchEvent', { type: k < 8 ? 'touchMove' : 'touchEnd', touchPoints }));
    }
    await Promise.all(sent);
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
  const log = await page.evaluate(readRunLogInPage);
  expect(log, '编辑页有“‹ 返回”：划调的就是它').toMatch(/tabswipe side=l .*to=btn/);
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

// 负责人 11-22 截图（纪念日编辑页“‹ 返回 / 纪念日”“妈妈生日”）：“生日跟纪念日页面没办法左滑右滑”——从左边缘往右划不返回。
// 编辑层本身是 Radix 模态对话框（role=dialog + aria-modal），原来横滑把它当成“弹层开着”，日志 skip=layer；
// 页面级的层标 data-route-page，不算弹层；它上面再叠的提醒弹层仍拦
const ANNIV = [
  { id: '0e2e0000-0000-4000-8000-00000022ab01', kind: 'birthday', name: '妈妈' },
  { id: '0e2e0000-0000-4000-8000-00000022ab02', kind: 'anniversary', name: '结婚' },
  // 倒数日写明年：过了日子的倒数日收进“已过去”，列表里点不到
  { id: '0e2e0000-0000-4000-8000-00000022ab03', kind: 'countdown', name: '上线', year: new Date().getUTCFullYear() + 1, next_date: `${new Date().getUTCFullYear() + 1}-12-25` },
] as const;
async function seedAnniv(page: Page): Promise<void> {
  const now = Date.now();
  const base = { calendar: 'solar', lunar_variant: 'cn', is_leap: false, after_due: 'archive', remind_offsets: null, remind_time: null, avatar_id: null, note: '',
    remind_at: null, snooze_at: null, notified_for: null, archived_at: null, deleted_at: null, undone: false, rev: 1, created_at: now - 86_400_000, updated_at: now,
    month: 12, day: 25, year: 2020, next_date: `${new Date().getUTCFullYear()}-12-25` };
  await idbPut(page, ANNIV.map((r) => ['anniversaries', cached({ ...base, ...r })] as const));
}

test('纪念日编辑页（生日、纪念日、倒数日）：从列表点进来，左边往右划退回列表；直接打开的新建页左边往右划回列表；提醒弹层开着时不响应', async ({ page, browserName }) => {
  // 三种各点进来划一次、再加弹层和直接打开：比默认 30 秒长
  test.setTimeout(120_000);
  await ready(page, '/app/#/anniv');
  await seedAnniv(page);
  await page.reload();
  await expect(page.getByTestId('anniv-list')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  const len0 = await len(page);
  for (const a of ANNIV) {
    await afterPageFade(page);
    await page.getByTestId('anniv-row').filter({ hasText: a.name }).click();
    await at(page, `anniv/${a.id}`);
    await expect(page.getByTestId('anniv-edit-layer')).toBeVisible();
    await expect(page.getByTestId(`anniv-kind-${a.kind}`)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(700);
    await swipe(page, browserName, L, 400, 160);
    await at(page, 'anniv');
    await expect(page.getByTestId('anniv-edit-layer')).toHaveCount(0);
    expect(await len(page)).toBe(len0);
    await page.waitForTimeout(700);
  }
  expect(await page.evaluate(readRunLogInPage)).toMatch(/tabswipe side=l .*to=btn/);
  // 提醒弹层（叠在编辑层上面的真弹层）开着：不返回
  await afterPageFade(page);
  await page.getByTestId('anniv-row').filter({ hasText: '妈妈' }).click();
  await expect(page.getByTestId('anniv-edit-layer')).toBeVisible();
  await page.waitForTimeout(700);
  await page.getByTestId('anniv-edit-remind').click();
  // 编辑层这时被提醒弹层盖住（读屏树里藏起来），按 DOM 数
  await expect(page.locator('[role="dialog"]')).toHaveCount(2);
  await swipe(page, browserName, L, 400, 160);
  await page.waitForTimeout(600);
  await at(page, `anniv/${ANNIV[0].id}`);
  expect(await page.evaluate(readRunLogInPage)).toMatch(/tabswipe side=l .*skip=layer/);
  // 直接打开的新建页（返回栈空）：回列表
  // 刷新即“直接打开”（返回栈存在 history.state，换地址再刷新就清了）；不等预加载（webkit 第二次载入时预加载日志迟迟不到，和这里无关）
  await page.evaluate(() => history.replaceState(null, '', '#/anniv/new'));
  await page.reload();
  await expect(page.getByTestId('anniv-edit-layer')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await swipe(page, browserName, L, 400, 160);
  await at(page, 'anniv');
  expect(await page.evaluate(readRunLogInPage)).toMatch(/tabswipe side=l .*to=btn/);
});

test('直接打开的最近删除页（没有返回栈）：左边往右划回设置（同页里“‹ 返回”）', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await ready(page, '/app/#/trash/todos');
  await expect(page.locator('main[data-feature]')).toBeVisible();
  await swipe(page, browserName, L, 400, 160);
  await at(page, 'settings');
});

// 负责人 11-22（弹窗“左滑是返回上一页，右滑还是直接回到设置”）：二级页从左边缘往右划，去处一律和点“‹ 返回”一样——划调的就是返回按钮登记的那个函数（kit/hooks/back-action.ts）
test('直接打开的日程编辑页：左边往右划回今天（同“‹ 返回”，原来划回日历）', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await ready(page, '/app/#/event/new');
  await expect(page.getByTestId('edit-back')).toBeVisible({ timeout: 30_000 });
  await swipe(page, browserName, L, 400, 160);
  await at(page, 'today');
  // 运行日志写进本机存储有先后：等它落下来再读
  await expect.poll(() => page.evaluate(readRunLogInPage)).toMatch(/tabswipe side=l .*to=btn/);
});

test('直接打开的设置三级页（勿扰时段）：左边往右划回提醒设置、再划回设置首页（同“‹ 返回”，原来一下回设置首页）', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await ready(page, '/app/#/settings/remind/dnd');
  await page.waitForTimeout(500);
  await swipe(page, browserName, L, 400, 160);
  await at(page, 'settings/remind');
  await page.waitForTimeout(700);
  await swipe(page, browserName, L, 400, 160);
  await at(page, 'settings');
});
