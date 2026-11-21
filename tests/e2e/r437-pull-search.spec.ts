// R-437 下拉搜索：随手记、待办、日历页滚到顶再往下拉，标题下面露出搜索框；打字就地筛本页（随手记标题 / 正文 / 分类，待办标题 / 子任务，日程标题），
// 隐私记不出；结果最底下“用 AI 按意思找”打开现有的查找面板（带上打的字）；“取消”清空并收起；运行日志有 pull open / find / ai，不带打的字。
// • 下拉手势：页面里派发只带 touches 坐标的 touchstart / touchmove / touchend（kit 的 usePullReveal 只读这几个），两种浏览器同一种做法；
//   电脑滚轮在顶上继续往上滚另验一次，电脑版随手记详情抽屉里滚轮不开（R-437 评审第 1 条；Chromium，WebKit 手机模拟不支持 mouse.wheel）
// • 键盘：Tab 到“搜索本页”才看得见，回车打开、输入框自动聚焦，Esc 收起、焦点回到“搜索本页”（评审第 3 条）
// • R-447（负责人 11-17 选 S-B 原列表筛选）：随手记、待办打了字原来的列表留着、只画命中的，命中的字下面一道短下划线（<mark>），框下一行条数，
//   列表下面“用 AI 按意思找 ›”，搜不到时居中提示；日历（不就地筛）照旧把本页只藏不卸（评审第 8 条：断言看不见，不断言不在）、结果在搜索框下面列
// • 设了 LEMO_SHOT_DIR 时在 Chromium 上截三页“露出 + 有结果”的图（430×932、DPR 3 → 1290 宽，同 iPhone 真机尺寸；浅色、深色）
// 跑在快读组（playwright.fastread.config.ts）：数据经 /sb 同步下来，要会话令牌
import type { Page } from '@playwright/test';
import { fakeRest } from './fake-rest.ts';
import { notesViewRows } from './idb.ts';
import { afterPageFade, readRunLogInPage, SHOT_DIR } from './page-helpers.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

logOnFail(test);
test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const USER = '0e2e0000-0000-4000-8000-000000000001';
const id = (n: number) => `0e2e0000-0000-4000-8000-0000004370${String(n).padStart(2, '0')}`;
const EV = id(1);
const TD = id(2);
const SUB = id(3);
const NT = id(4);
const VN = id(5);
const CAT = id(6);
const NT2 = id(7);
const TD2 = id(8);

async function fakeServer(page: Page, baseURL: string | undefined): Promise<void> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const at = new Date(now).toISOString();
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const item = { project: '', source: 'page', raw_text: '', short: null, short_by: null, push_show_title: null, batch_id: null, notified_for: null, snooze_at: null };
  const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const note = { is_private: false, category_id: null, category_source: 'none', category_seen: true, sort_key: null, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null };
  const todo = { note: '', due: null, done: false, important: false, priority: 'mid', sort_key: null, from_note_id: null, from_anniv_id: null, done_at: 0, remind_days: null, remind_time: '09:00', due_time: null, remind_before_min: null };
  const tables: Record<string, Record<string, unknown>[]> = {
    events: [
      { id: EV, ...c, ...item, title: '看牙医', date: day, time: '15:00', tz: 'Asia/Seoul', duration_min: 60, location: '江南站 3 号口', note: '', remind_min: null, remind_days: null },
      { id: id(9), ...c, ...item, title: '周会', date: day, time: '10:00', tz: 'Asia/Seoul', duration_min: 60, location: '牙医楼上', note: '', remind_min: null, remind_days: null },
    ],
    todos: [
      { id: TD, ...c, ...item, ...todo, title: '出差准备' },
      { id: TD2, ...c, ...item, ...todo, title: '交房租' },
    ],
    todo_items: [{ id: SUB, ...c, todo_id: TD, title: '带护照', done: false, sort: 1 }],
    categories: [{ id: CAT, ...c, name: '吃喝', color: null, sort: 1, created_by: 'ai', merged_into: null }],
    notes: [
      { id: NT, ...c, ...note, title: '拉面店', body: '弘大那家拉面店，汤头很浓。', category_id: CAT },
      { id: NT2, ...c, ...note, title: '书单', body: '下个月读完三本' },
      { id: VN, ...c, ...note, title: '拉面秘方', body: '隐私记', is_private: true },
    ],
    // 随手记页找的是瀑布流卡片：两类设备明确写 masonry（负责人 11-18 首装默认改列表）
    settings: [{ id: id(30), ...c, key: 'ai.enabled', value: true }, ...notesViewRows('masonry', c)],
  };
  await fakeRest(page, { user: USER, tables, profile: { consent_ai_at: at } });
  await page.route(/\/sb\/functions\/v1\/note-search/, (route) => route.fulfill({ json: { hits: [] } }));
}

const runLog = (page: Page) => page.evaluate(readRunLogInPage);

async function openPage(page: Page, hash: string, testId: string, ready: string): Promise<void> {
  await page.goto(`/app/#/${hash}`);
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(ready).first()).toBeVisible({ timeout: 30_000 });
  await afterPageFade(page);
}

/** 在页面里从 (x, 120) 往下拉 dy（只带 touches 坐标的 touch 事件，见文件头） */
// 默认拉 240：远过 src/kit/hooks/usePullReveal.ts 的 PULL_OPEN_PX（R-488 起占位框过半就开，约 37px）
async function pullDown(page: Page, testId: string, dy = 240): Promise<void> {
  await page.evaluate(({ sel, dy }) => {
    const el = document.querySelector(`[data-testid="${sel}"]`) ?? document.body;
    const fire = (type: string, y: number | null) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'touches', { value: y === null ? [] : [{ clientX: 200, clientY: y }] });
      el.dispatchEvent(ev);
    };
    fire('touchstart', 120);
    for (let i = 1; i <= 6; i++) fire('touchmove', 120 + (dy * i) / 6);
    fire('touchend', null);
  }, { sel: testId, dy });
}

async function search(page: Page, pageId: string, q: string): Promise<void> {
  await expect(page.getByTestId('pull-search')).toHaveCount(0);
  await pullDown(page, pageId);
  await expect(page.getByTestId('pull-input')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('pull-input').fill(q);
  await expect(page.getByTestId('pull-count')).toBeVisible();
}

test.describe('R-437 下拉搜索：手机', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('随手记：下拉露出 → 原列表按标题 / 正文 / 分类就地筛、隐私记不出 → “用 AI 按意思找”打开查找面板 → 取消收起；日志不带打的字', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL);
    await openPage(page, 'notes', 'notes', `notes-card-${NT}`);
    // R-488（负责人 11-20“在顶部的时候往下拉页面不动，只出搜索框”，选“跟手拉出”）：拉着的时候页面本身不动（top-lock 拦下 touchmove 默认）、
    // 标题下面的占位框跟手长出；拉得不够（30px → 框长 18，不到 44 的一半）松手缩回、不露出搜索框
    const mid = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="notes"]') as HTMLElement;
      const fire = (type: string, y: number | null): boolean => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: y === null ? [] : [{ clientX: 200, clientY: y }] });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      fire('touchstart', 120);
      const blocked = fire('touchmove', 150);
      const g = document.querySelector('[data-testid="pull-ghost"]') as HTMLElement;
      const h = g.getBoundingClientRect().height;
      fire('touchend', null);
      return { blocked, h: Math.round(h), y: window.scrollY };
    });
    expect(mid).toEqual({ blocked: true, h: 18, y: 0 });
    await page.waitForTimeout(400);
    await expect(page.getByTestId('pull-search')).toHaveCount(0);
    expect(await page.getByTestId('pull-ghost').evaluate((g) => Math.round(g.getBoundingClientRect().height))).toBe(0);
    await search(page, 'notes', '拉面');
    await expect(page.getByTestId('pull-input')).toHaveAttribute('placeholder', '搜索随手记');
    // 原列表就地筛：命中的卡片还是原来那张，命中的字有下划线；没命中的不画；隐私记不出；不另出结果列表
    await expect(page.getByTestId(`notes-card-${NT}`)).toBeVisible();
    await expect(page.getByTestId(`notes-card-${NT}`).locator('mark').first()).toHaveText('拉面');
    await expect(page.getByTestId(`notes-card-${NT2}`)).toHaveCount(0);
    await expect(page.getByTestId('notes-mason')).not.toContainText('拉面秘方');
    await expect(page.getByTestId('pull-results')).toHaveCount(0);
    await expect(page.getByTestId('pull-count')).toHaveText('1 条');
    // 分类名、正文也能筛
    await page.getByTestId('pull-input').fill('吃喝');
    await expect(page.getByTestId(`notes-card-${NT}`)).toBeVisible();
    await page.getByTestId('pull-input').fill('三本');
    await expect(page.getByTestId(`notes-card-${NT2}`)).toBeVisible();
    await expect(page.getByTestId(`notes-card-${NT}`)).toHaveCount(0);
    // 搜不到：居中一句 + 同一个“用 AI 按意思找”
    await page.getByTestId('pull-input').fill('发票');
    await expect(page.getByTestId('pull-empty')).toContainText('随手记里没有“发票”。');
    await expect(page.getByTestId('pull-count')).toHaveText('0 条');
    await page.getByTestId('pull-input').fill('三本');
    // 用 AI 按意思找：打开现有查找面板，输入框里是打的字
    await page.getByTestId('pull-ai').click();
    await expect(page.getByTestId('find-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('find-input')).toHaveValue('三本');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('find-panel')).toHaveCount(0);
    // 搜索框还在，筛的结果还在；取消清空并收起，列表全回来
    await expect(page.getByTestId('pull-input')).toHaveValue('三本');
    await page.getByTestId('pull-cancel').click();
    await expect(page.getByTestId('pull-search')).toHaveCount(0);
    await expect(page.getByTestId(`notes-card-${NT}`)).toBeVisible();
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/pull close notes/);
    const log = await runLog(page);
    expect(log).toMatch(/pull open notes via=touch/);
    expect(log).toMatch(/pull find note len=\d+ n=\d+ shown=\d+ ms=\d+/);
    expect(log).toMatch(/pull ai note n=1/);
    expect(log).toMatch(/find open from=pull/);
    for (const w of ['拉面', '吃喝', '三本']) expect(log).not.toContain(w);
  });

  test('待办：原列表就地筛（按子任务命中的那一行留着），条数“1 未完成”；命中标题的字有下划线；搜不到居中提示；点行照常进编辑页', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL);
    await openPage(page, 'todos', 'todos', `todos-row-${TD}`);
    await search(page, 'todos', '护照');
    await expect(page.getByTestId('pull-input')).toHaveAttribute('placeholder', '搜索待办');
    await expect(page.getByTestId(`todos-row-${TD}`)).toBeVisible();
    await expect(page.getByTestId(`todos-row-${TD2}`)).toHaveCount(0);
    await expect(page.getByTestId('pull-count')).toContainText('1 未完成');
    await expect(page.getByTestId('pull-scope')).toHaveValue('open');
    await page.getByTestId('pull-input').fill('房租');
    await expect(page.getByTestId(`todos-row-${TD2}`).locator('mark')).toHaveText('房租');
    await expect(page.getByTestId(`todos-row-${TD}`)).toHaveCount(0);
    await page.getByTestId('pull-input').fill('发票');
    await expect(page.getByTestId('pull-empty')).toContainText('待办里没有“发票”。');
    await page.getByTestId('pull-input').fill('出差');
    await page.getByTestId(`todos-row-${TD}`).getByText('准备').click();
    await expect(page).toHaveURL(new RegExp(`#/todo/${TD}`));
  });

  test('日历：只按日程标题筛（地点里有字的不出）；点一条进日程编辑页', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL);
    await openPage(page, 'calendar', 'calendar-page', 'cal-title');
    await search(page, 'calendar-page', '牙医');
    await expect(page.getByTestId('pull-input')).toHaveAttribute('placeholder', '搜索日程');
    await expect(page.getByTestId(`pull-row-${EV}`)).toBeVisible();
    await expect(page.getByTestId(`pull-row-${EV}`).locator('mark').first()).toHaveText('牙医');
    await expect(page.getByTestId('pull-count')).toHaveText('1 条');
    await expect(page.getByTestId(`pull-row-${id(9)}`)).toHaveCount(0);
    await expect(page.getByTestId('cal-pager')).toBeHidden();
    await page.getByTestId(`pull-row-${EV}`).click();
    await expect(page).toHaveURL(new RegExp(`#/event/${EV}`));
  });

  test('露出没打字、页面往上滚：搜索框跟着滚动量慢慢淡出，滚走停下以后才收起（负责人 11-20“慢慢收进去”）', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL);
    await openPage(page, 'todos', 'todos', `todos-row-${TD}`);
    // 列表短、页面滚不动：页面底下垫一块高的，让它能往上滚
    await page.evaluate(() => {
      const pad = document.createElement('div');
      pad.style.height = '3000px';
      document.body.append(pad);
    });
    await pullDown(page, 'todos');
    await expect(page.getByTestId('pull-input')).toBeVisible({ timeout: 10_000 });
    // 透明度在页面里记（不拿 locator 隔一阵去读）：淡到 0 以后停稳 STILL_MS 就卸掉，CI webkit 一帧 150～400 ms 时，隔 100、250、500 ms 去读
    // 会整段错过“已经是 0、还没卸”那一下，卸掉以后 locator 一直等、只剩上一次读到的 0.5（11-20 CI 7555dd5a）。
    // 每次 scroll 事件记一次（排在页面自己的监听后面，读到的是它刚写的），卸掉以后停在卸掉前最后一次：没淡到 0 就卸掉照样失败
    await page.getByTestId('pull-head').evaluate((head) => {
      const w = window as Window & { __pullOp?: number };
      const read = (): void => {
        if (head.isConnected) w.__pullOp = Number(getComputedStyle(head).opacity);
      };
      read();
      window.addEventListener('scroll', read, { passive: true });
    });
    const opacity = () => page.evaluate(() => (window as Window & { __pullOp?: number }).__pullOp);
    await page.evaluate(() => window.scrollTo(0, 22));
    expect(await page.evaluate(() => window.scrollY)).toBe(22);
    await expect.poll(opacity).toBeLessThan(0.75);
    expect(await opacity()).toBeGreaterThan(0.25);
    // 滚过 PULL_H：已经全透明，停下以后才卸掉
    await page.evaluate(() => window.scrollTo(0, 300));
    expect(await page.evaluate(() => window.scrollY)).toBe(300);
    await expect.poll(opacity).toBe(0);
    await expect(page.getByTestId('pull-search')).toHaveCount(0, { timeout: 5_000 });
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/pull close todos/);
  });
});

test.describe('R-437 下拉搜索：键盘', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Tab 到“搜索本页”才看得见；回车打开、输入框聚焦；Esc 收起、焦点回到它', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL);
    await openPage(page, 'todos', 'todos', `todos-row-${TD}`);
    const key = page.getByTestId('pull-key');
    // 平时视觉隐藏（读屏照样读得到）
    expect((await key.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
    await expect(key).toHaveAccessibleName('搜索本页');
    await expect(async () => {
      await page.keyboard.press('Tab');
      await expect(key).toBeFocused({ timeout: 200 });
    }).toPass({ timeout: 15_000 });
    expect((await key.boundingBox())?.width ?? 0).toBeGreaterThan(40);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pull-input')).toBeFocused();
    await page.keyboard.type('护照');
    await expect(page.getByTestId(`todos-row-${TD2}`)).toHaveCount(0);
    await expect(page.getByTestId(`todos-row-${TD}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pull-search')).toHaveCount(0);
    await expect(page.getByTestId(`todos-row-${TD}`)).toBeVisible();
    await expect(key).toBeFocused();
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/pull open todos via=key[\s\S]*pull close todos/);
  });
});

test.describe('R-437 下拉搜索：电脑滚轮', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('滚到顶以后滚轮继续往上滚露出搜索框', async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit 这一组是 iPhone 模拟，不支持 mouse.wheel');
    await fakeServer(page, baseURL);
    await openPage(page, 'todos', 'todos', `todos-row-${TD}`);
    const box = await page.getByTestId(`todos-row-${TD}`).boundingBox();
    await page.mouse.move((box?.x ?? 300) + 40, (box?.y ?? 200) + 10);
    await expect(async () => {
      await page.mouse.wheel(0, -100);
      await page.mouse.wheel(0, -100);
      await expect(page.getByTestId('pull-search')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/pull open todos via=wheel/);
  });

  test('电脑版随手记：详情抽屉里往上滚不开搜索；回到列表上往上滚才开', async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit 这一组是 iPhone 模拟，不支持 mouse.wheel，也没有电脑版');
    await fakeServer(page, baseURL);
    await openPage(page, 'notes', 'notes', `notes-card-${NT}`);
    await expect(page.getByTestId('desk-panel-list')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`notes-card-${NT}`).locator('button').first().click();
    const drawer = page.getByTestId('note-drawer');
    await expect(drawer).toBeVisible();
    const db = await drawer.boundingBox();
    await page.mouse.move((db?.x ?? 900) + (db?.width ?? 300) / 2, (db?.y ?? 100) + (db?.height ?? 600) / 2);
    // 每一串之间隔开 WHEEL_GAP_MS 以上（不在抽屉里的话，这样早就开了）
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -100);
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(400);
    }
    await expect(page.getByTestId('pull-search')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    // 对照：同样的滚法在列表上会开
    const lb = await page.getByTestId(`notes-card-${NT}`).boundingBox();
    await page.mouse.move((lb?.x ?? 300) + 20, (lb?.y ?? 200) + 10);
    await page.waitForTimeout(400);
    await expect(async () => {
      await page.mouse.wheel(0, -100);
      await page.mouse.wheel(0, -100);
      await expect(page.getByTestId('pull-search')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    expect(await runLog(page)).toMatch(/pull open notes via=wheel/);
  });
});

test.describe('R-437 下拉搜索：评审截图', () => {
  test.use({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

  test('三页露出 + 有结果（浅色、深色）', async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium' || !SHOT_DIR, '只在 Chromium、设了 LEMO_SHOT_DIR 时截');
    await fakeServer(page, baseURL);
    const cases: [string, string, string, string, string][] = [
      ['notes', 'notes', `notes-card-${NT}`, '拉面', '随手记'],
      ['todos', 'todos', `todos-row-${TD}`, '护照', '待办'],
      ['calendar', 'calendar-page', 'cal-title', '牙医', '日历'],
    ];
    for (const [hash, pageId, ready, q, name] of cases) {
      await page.emulateMedia({ colorScheme: 'light' });
      await openPage(page, hash, pageId, ready);
      await search(page, pageId, q);
      await page.getByTestId('pull-input').blur();
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${SHOT_DIR}/${name}-${scheme === 'light' ? '浅色' : '深色'}.png`, animations: 'disabled' });
      }
    }
  });
});
