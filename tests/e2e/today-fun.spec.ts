// 今天页没日程时的组合区（负责人 11-22、11-23 定稿 今天页空白趣味 方案4.html；src/features/today/ui/TodayFun.tsx），chromium、webkit 都跑：
//   假时钟 2026-11-28（周六）10:20 首尔；今天没有日程、没有今天截止的待办；本机库里有一件没定日期的“换卧室的灯泡”（3 天前记的）、
//   7 天内的生日“小满”（5 天后）、填好的运势生日；这周（11-22 周日起）每天做完 2 1 3 0 2 1 0 件、上周 6 件
//   ① “今天的安排 0”下面出组合区：顺手做那一件、今日小运（星星，和日历页运势卡同一个）、这周做完 9 件 · 比上周 +3、七根柱子 日 到 六、今天（六）那根下面的字加深
//   ② 点今日小运开出详情（运势卡同一个弹层），关上
//   ③ 点“放进今天”：这一件进了今天的安排，组合区收起
// 评审截图（设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截）：430×932、DPR 3 的浅色、深色各一张（和定稿 方案4_组合_1扁平圆胖_浅色/深色_430x932.png 并排对照用）
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { SHEET_GONE, shot } from './page-helpers.ts';
import { expect, FAKE_USER_ID, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const NOW = new Date('2026-11-28T10:20:00+09:00');
const DAY = 86_400_000;
const QUICK = '0e2e0000-0000-4000-8000-00000000f001';
const at = (d: string): number => new Date(`${d}T12:00:00+09:00`).getTime();

async function seed(page: Page, dueToday = false): Promise<void> {
  const now = NOW.getTime();
  const base = { user_id: FAKE_USER_ID, created_at: now - 10 * DAY, updated_at: now - DAY, deleted_at: null, undone: false, short: null, project: '', tz: TZ };
  const todo = (id: string, o: Record<string, unknown>) => ({ ...base, id, title: '做完的事', done: false, due: null, due_time: null, priority: 'mid', important: false, done_at: 0, ...o });
  // 这周 日 一 二 三 四 五 六 做完 2 1 3 0 2 1 0 件（9 件），上周 6 件；做完的都没定日期，不进今天的安排
  const week = [2, 1, 3, 0, 2, 1, 0];
  const days = ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'];
  const done: Record<string, unknown>[] = [];
  let k = 0;
  const id = () => `0e2e0000-0000-4000-8000-0000000f${String(100 + k++).padStart(4, '0')}`;
  week.forEach((n, i) => {
    for (let j = 0; j < n; j++) done.push(todo(id(), { done: true, done_at: at(days[i] ?? '') }));
  });
  for (const d of ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']) done.push(todo(id(), { done: true, done_at: at(d) }));
  const quick = todo(QUICK, { title: '换卧室的灯泡', created_at: at('2026-11-25') });
  // 负责人 11-23 截图“今天的待办勾选完了，没出来这次改的”：今天截止的待办都勾完了，也要出组合区
  if (dueToday) done.push(todo('0e2e0000-0000-4000-8000-00000000f0d1', { title: '交房租', due: '2026-11-28', done: true, done_at: NOW.getTime() - 3_600_000 }));
  const ab = { calendar: 'solar', lunar_variant: 'cn', is_leap: false, after_due: 'archive', remind_offsets: null, remind_time: null, avatar_id: null, note: '',
    remind_at: null, snooze_at: null, notified_for: null, archived_at: null, deleted_at: null, undone: false, rev: 1, created_at: now - DAY, updated_at: now };
  const anniv = { ...ab, user_id: FAKE_USER_ID, id: '0e2e0000-0000-4000-8000-00000000fa01', kind: 'birthday', name: '小满', month: 12, day: 3, year: 1998, next_date: '2026-12-03' };
  const birth = { id: '0e2e0000-0000-4000-8000-00000000fb01', user_id: FAKE_USER_ID, key: 'cal.fortune_birth', value: { y: 1992, m: 6, d: 12, h: null }, deleted_at: null, undone: false, rev: 1, updated_at: now };
  await idbPut(page, [
    ...[...done, quick].map((r) => ['todos', cached(r)] as const),
    ['anniversaries', cached(anniv)],
    ['settings', cached(birth)],
  ]);
  await page.reload();
}

/** 打开今天页、写示例数据、等组合区出来（首屏画完才下载那一包，webkit 冷启动慢，多等一会） */
async function open(page: Page, dueToday = false) {
  await page.clock.setFixedTime(NOW);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('now-card')).toBeVisible({ timeout: 30_000 });
  await seed(page, dueToday);
  const fun = page.getByTestId('today-fun');
  await expect(fun).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('fortune-tile')).toBeVisible({ timeout: 20_000 });
  return fun;
}

test.describe('今天页没日程时的组合区', () => {
  test('今天截止的待办都勾完了也出组合区，排在“已过去 1 件”下面（负责人 11-23 截图）', async ({ page, browserName }) => {
    test.setTimeout(120_000);
    const fun = await open(page, true);
    const past = page.getByTestId('today-past');
    await expect(past).toContainText('交房租');
    const [a, b] = await Promise.all([past.boundingBox(), fun.boundingBox()]);
    expect((b?.y ?? 0) > (a?.y ?? 0)).toBe(true);
    await expect(page.getByTestId('today-list')).not.toContainText('今天没有安排');
    await shot(page, browserName, 'today-fun-all-done');
    // 负责人 11-23 截图“展开时跟下面的页面没有缝隙，很拥挤”：展开“已过去”后清单卡和组合区隔开 12
    await past.click();
    await expect(past).toHaveAttribute('aria-expanded', 'true');
    const card = page.getByTestId('today-list').locator('ul').first();
    await expect.poll(async () => {
      const [c, f] = await Promise.all([card.boundingBox(), fun.boundingBox()]);
      return Math.round((f?.y ?? 0) - ((c?.y ?? 0) + (c?.height ?? 0)));
    }).toBeGreaterThanOrEqual(12);
    await shot(page, browserName, 'today-fun-all-done-open');
  });

  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, timezoneId: TZ, locale: 'zh-CN', colorScheme: 'light' });

  test('顺手做、今日小运、这周做完（周日起）；点小运开详情，点“放进今天”收起', async ({ page, browserName }) => {
    test.setTimeout(120_000);
    const fun = await open(page);
    await expect(page.getByTestId('today-anniv')).toContainText('5 天后');
    await expect(page.getByTestId('today-anniv')).toContainText('小满 生日');
    const quick = page.getByTestId('today-fun-quick');
    await expect(quick).toContainText('今天空着，要不要把它做了？');
    await expect(quick).toContainText('换卧室的灯泡');
    await expect(quick).toContainText('没定日期 · 3 天前记的');
    const week = page.getByTestId('today-fun-week');
    await expect(week).toHaveAttribute('data-n', '9');
    await expect(week).toHaveAttribute('data-diff', '3');
    await expect(week).toContainText('比上周 +3');
    const cols = page.getByTestId('today-fun-bars').locator(':scope > div');
    await expect(cols).toHaveText(['日', '一', '二', '三', '四', '五', '六']);
    expect(await cols.evaluateAll((els) => els.map((e) => e.getAttribute('data-n')))).toEqual(['2', '1', '3', '0', '2', '1', '0']);
    // 今天（周六）那根下面的字加粗
    expect(await cols.nth(6).locator('span').evaluate((e) => getComputedStyle(e).fontWeight)).toBe('600');
    expect(await cols.nth(0).locator('span').evaluate((e) => getComputedStyle(e).fontWeight)).toBe('400');
    // 柱子高度照定稿：2 件 22px、3 件 30px、0 件 4px
    const h = (i: number) => cols.nth(i).locator('i').evaluate((e) => e.getBoundingClientRect().height);
    expect([await h(0), await h(2), await h(3)]).toEqual([22, 30, 4]);
    const tile = page.getByTestId('fortune-tile');
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('今日小运');
    await expect(tile).toContainText('看详情');
    // 两个小方块并排、一样高
    const [a, b] = [await tile.boundingBox(), await week.boundingBox()];
    expect(a && b && Math.abs(a.y - b.y) < 1 && Math.abs(a.height - b.height) < 1).toBe(true);

    await shot(page, browserName, 'today-fun-light');

    await tile.click();
    await expect(page.getByTestId('fortune-detail')).toBeVisible();
    // 负责人 11-23 截图：详情一打开“×”套着大黑框——打开时焦点不落在“×”上，“×”没有焦点框
    const x = page.getByTestId('fortune-close');
    await expect(x).not.toBeFocused();
    expect(await x.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('none');
    await shot(page, browserName, 'today-fortune-open');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('fortune-detail')).toHaveCount(0, SHEET_GONE);

    await page.getByTestId('today-fun-go').click();
    await expect(page.getByTestId(`today-row-${QUICK}`)).toBeVisible();
    await expect(fun).toHaveCount(0);
  });
});

/** 小运卡此刻的焦点和焦点框 */
const tileRing = (page: Page) =>
  page.getByTestId('fortune-tile').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { focused: document.activeElement === el, fv: el.matches(':focus-visible'), quiet: el.hasAttribute('data-quiet-focus'), style: cs.outlineStyle, w: parseFloat(cs.outlineWidth) || 0 };
  });

test.describe('今日小运弹层关上还焦点（负责人 11-23 截图：关掉详情后小运卡套着一圈黑框）', () => {
  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: TZ, locale: 'zh-CN' });

  test('指针点开、点“×”关上：焦点还给小运卡（读屏接着读），但不画框', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const tile = page.getByTestId('fortune-tile');
    await tile.click();
    await expect(page.getByTestId('fortune-detail')).toBeVisible();
    await page.getByTestId('fortune-close').click();
    await expect(page.getByTestId('fortune-detail')).toHaveCount(0, SHEET_GONE);
    await expect.poll(async () => (await tileRing(page)).focused, { timeout: 5000 }).toBe(true);
    const r = await tileRing(page);
    expect(r.quiet, '指针操作带 data-quiet-focus').toBe(true);
    expect(r.style, `不画框（outline ${r.style} ${r.w}px，:focus-visible=${r.fv}）`).toBe('none');
  });

  test('键盘 Tab 到小运卡、回车打开、Esc 关上：焦点回到小运卡，照旧画焦点框', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    // 先用指针点一下页面空白处，再改用键盘：确认换成键盘以后框照旧回来
    await page.mouse.click(5, 400);
    for (let i = 0; i < 40 && !(await tileRing(page)).focused; i++) await page.keyboard.press('Tab');
    expect((await tileRing(page)).focused, 'Tab 能走到小运卡').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('fortune-detail')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('fortune-detail')).toHaveCount(0, SHEET_GONE);
    await expect.poll(async () => (await tileRing(page)).focused, { timeout: 5000 }).toBe(true);
    const r = await tileRing(page);
    expect(r.quiet, '键盘操作不带 data-quiet-focus').toBe(false);
    expect(r.style !== 'none' && r.w > 0, `画框（outline ${r.style} ${r.w}px）`).toBe(true);
  });
});

test.describe('今天页没日程时的组合区 · 深色', () => {
  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, timezoneId: TZ, locale: 'zh-CN', colorScheme: 'dark' });

  test('深色下同样画出组合区（评审截图）', async ({ page, browserName }) => {
    test.setTimeout(120_000);
    await open(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset['theme'])).toBe('dark');
    await expect(page.getByTestId('today-fun-week')).toContainText('比上周 +3');
    await shot(page, browserName, 'today-fun-dark');
  });
});
