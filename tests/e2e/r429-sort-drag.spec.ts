// 长按拖动排序（R-429，含 R-433 拿起时左边的 6 个点）：不要后端，往本机库 planner-v4 写好行再重新载入，用鼠标“按住 0.5 秒 → 拖 → 松手”
// • 待办页：拿起的那一行 6 个点显出来、落点一条横线；组内换序 → “已移动 · 撤销”、写进 outbox、顺序变了；拖到“明天”那一组 → “已改到 明天”，撤销回到今天
// • 随手记页（列表方式）：第一次拖 → “已切到自己排，设置里可改回”，不按天分组、顺序照放下的；设置 › 随手记显示方式里“随手记排序”是“自己排”，切回“按时间”恢复原顺序
// • 按住不到 0.4 秒就动：不拿起（没有横线）
// • 设了 LEMO_SHOT_DIR 时，Chromium 在拖动中各截一帧（430×932、DPR 3），给负责人看 6 个点和落点横线
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { runLog } from './fake-media.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, locale: 'zh-CN' });
const SHOT_DIR = process.env['LEMO_SHOT_DIR'] ?? '';

const todo = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, priority: 'mid', rev: 1 };
const note = (id: string, body: string, ago: number) => ({
  id, user_id: FAKE_USER_ID, title: null, body, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
  tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false, created_at: Date.now() - ago, updated_at: 1, rev: 1,
});

const dayOf = (page: Page, offset: number) =>
  page.evaluate(([tz, off]) => new Intl.DateTimeFormat('en-CA', { timeZone: tz as string, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + (off as number) * 86400000)), [TZ, offset] as const);

const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

/** 按住 holdMs 再拖到 target 上沿往下 dy 处（分几步走），拖着的时候回调 during，然后松手 */
async function drag(page: Page, from: Locator, target: Locator, dy: number, during?: () => Promise<void>, holdMs = 550): Promise<void> {
  // 刚重新载入时行可能还没排版出来（boundingBox 为 null）：先等两行都看得见
  await expect(from).toBeVisible();
  await expect(target).toBeVisible();
  const a = await from.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error('找不到行');
  const x = a.x + a.width * 0.45;
  const y = a.y + a.height / 2;
  // 换页动画进行中整页暂时不接点按：等按下的那一点真的落在这一行上
  const id = await from.getAttribute('data-sort-id');
  await expect.poll(() => page.evaluate(([px, py]) => document.elementFromPoint(px as number, py as number)?.closest('[data-sort-id]')?.getAttribute('data-sort-id') ?? null, [x, y] as const)).toBe(id);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  // 要拿起的那种：等这一行真拿起来再动（机器很忙时 0.4 秒的计时会晚到，先动就成了“动了不拿起”）
  if (holdMs >= 400) await expect(from).toHaveAttribute('data-sort-lifted', '');
  await page.mouse.move(b.x + b.width * 0.45, b.y + dy, { steps: 12 });
  await page.waitForTimeout(120);
  if (during) await during();
  await page.mouse.up();
}

const ids = (page: Page, prefix: string) =>
  page.locator(`[data-testid^="${prefix}"]`).evaluateAll((els, p) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice((p as string).length)), prefix);

/** 拿起的那一行看得到 6 个点、落点横线显出来 */
async function expectLifted(page: Page, row: Locator): Promise<void> {
  await expect(row).toHaveAttribute('data-sort-lifted', '');
  const grip = row.getByTestId('sort-grip');
  await expect(grip.locator('i')).toHaveCount(6);
  await expect.poll(() => grip.evaluate((e) => Number(getComputedStyle(e).opacity))).toBeGreaterThan(0.9);
  await expect(page.getByTestId('sort-line')).toBeVisible();
}

async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (!SHOT_DIR || browserName !== 'chromium') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}

test.describe('长按拖动排序（R-429、R-433）', () => {
  // 失败时把运行日志里拖动、左滑那几行打出来（先看日志定根因）
  test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) console.log((await runLog(page).catch(() => [])).filter((l) => /sort|swipe|hdrag/.test(l)).slice(-40).join('\n'));
  });

  test('待办页：组内换序、拖到明天改截止、撤销；按住不够久不拿起', async ({ page, browserName }) => {
    await page.goto('/app/#/todos');
    await page.waitForLoadState('domcontentloaded');
    const today = await dayOf(page, 0);
    const tomorrow = await dayOf(page, 1);
    await idbPut(page, [
      { ...todo, id: 't1', title: '交报销单', due: today, created_at: 3 },
      { ...todo, id: 't2', title: '准备提纲', due: today, created_at: 2 },
      { ...todo, id: 't3', title: '给猫买猫砂', due: today, created_at: 1 },
      { ...todo, id: 'm1', title: '取快递', due: tomorrow },
    ].map((r) => ['todos', cached(r)] as const));
    await page.reload();
    const row = (id: string) => page.getByTestId(`todos-row-${id}`);
    await row('t1').waitFor({ timeout: 30000 });
    // 今天那一组此刻的顺序（没拖过的按原规则排）
    const todayIds = () => page.locator('[data-sort-group="today:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-sort-id') ?? ''));
    const before = await todayIds();
    expect(before).toHaveLength(3);
    const [first, mid, last] = before as [string, string, string];

    // 按住不到 0.4 秒就动：不拿起，顺序不变
    await drag(page, row(last), row(first), 2, async () => {
      await expect(page.getByTestId('sort-line')).toBeHidden();
    }, 150);
    expect(await todayIds()).toEqual(before);

    // 组内换序：最后一条拖到最上面
    await drag(page, row(last), row(first), 2, async () => {
      await expectLifted(page, row(last));
      await shot(page, browserName, 'todos-dragging');
    });
    await expect(page.getByTestId('todos-moved-toast')).toContainText('已移动');
    await expect.poll(todayIds).toEqual([last, first, mid]);
    await expect.poll(() => outboxOf(page)).toContain(`todos:${last}:patch`);
    await expect(row(last)).not.toHaveAttribute('data-sort-lifted', '');

    // 跨组：原来的第一条拖到“明天”那一组里 m1 下面
    await drag(page, row(first), row('m1'), 40);
    await expect(page.getByTestId('todos-moved-toast')).toContainText('已改到 明天');
    // 换组时旧位置那一行先做退出动画，同一个 testid 短暂有两个：等只剩一个再看
    const inGroup = (id: string, g: string) => page.locator(`[data-testid="todos-row-${id}"][data-sort-group="${g}"]`);
    await expect(inGroup(first, 'tomorrow:')).toHaveCount(1);
    await expect(row(first)).toHaveCount(1);
    // 撤销：回到今天
    await page.getByTestId('todos-moved-toast').getByRole('button').click();
    await expect(inGroup(first, 'today:')).toHaveCount(1);
    await expect(row(first)).toHaveCount(1);
  });

  test('随手记页（列表方式）：第一次拖切到自己排、顺序照放下的；设置里切回按时间', async ({ page, browserName }) => {
    await page.goto('/app/#/notes');
    await page.getByTestId('notes').waitFor({ timeout: 30000 });
    await idbPut(page, [note('n1', '首尔林银杏黄了', 60_000), note('n2', '牛奶、鸡蛋', 120_000), note('n3', '下周末带相机', 180_000)].map((r) => ['notes', cached(r)] as const));
    await page.reload();
    await page.getByTestId('notes').waitFor({ timeout: 30000 });
    await page.goto('/app/#/settings/notes-view');
    await page.getByText('列表', { exact: true }).click();
    await expect(page.getByTestId('settings-notes-view-list')).toBeChecked();
    await expect(page.getByTestId('settings-notes-order-time')).toBeChecked();
    await page.goto('/app/#/notes');
    const row = (id: string) => page.getByTestId(`notes-row-${id}`);
    await row('n1').waitFor({ timeout: 30000 });
    expect(await ids(page, 'notes-row-')).toEqual(['n1', 'n2', 'n3']);

    // n3 拖到 n1 和 n2 之间
    await drag(page, row('n3'), row('n2'), 2, async () => {
      await expectLifted(page, row('n3'));
      await shot(page, browserName, 'notes-dragging');
    });
    await expect(page.getByTestId('notes-moved-toast')).toContainText('已切到自己排，设置里可改回');
    await expect.poll(() => ids(page, 'notes-row-')).toEqual(['n1', 'n3', 'n2']);
    await expect(page.getByTestId('notes-list').locator('h2')).toHaveCount(0);
    await expect.poll(() => outboxOf(page)).toContain('notes:n3:patch');

    // 再拖一次：只说“已移动”
    await drag(page, row('n2'), row('n1'), 2);
    await expect(page.getByTestId('notes-moved-toast')).toContainText('已移动');
    await expect.poll(() => ids(page, 'notes-row-')).toEqual(['n2', 'n1', 'n3']);

    // 设置里切回按时间：恢复按记的时刻、按天分组
    await page.goto('/app/#/settings/notes-view');
    await expect(page.getByTestId('settings-notes-order-manual')).toBeChecked();
    // 原生单选框是视觉隐藏的，整行是 label：点这一行
    await page.locator('label', { has: page.getByTestId('settings-notes-order-time') }).click();
    await expect(page.getByTestId('settings-notes-order-time')).toBeChecked();
    await page.goto('/app/#/notes');
    await row('n1').waitFor({ timeout: 30000 });
    await expect.poll(() => ids(page, 'notes-row-')).toEqual(['n1', 'n2', 'n3']);
  });

  // 电脑版布局是首屏后才换上的（外框整个换了一个元素），换上以后照样能拖（评审第 1 条：监听不能留在旧外框上）
  test.describe('电脑宽度', () => {
    test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    test('电脑版随手记（瀑布流）：换上电脑版以后照样能拖', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '电脑版只在桌面 Chromium 看');
      await page.goto('/app/#/notes');
      await page.getByTestId('notes').waitFor({ timeout: 30000 });
      await idbPut(page, [note('n1', '首尔林银杏黄了', 60_000), note('n2', '牛奶、鸡蛋', 120_000), note('n3', '下周末带相机', 180_000)].map((r) => ['notes', cached(r)] as const));
      await page.reload();
      const card = (id: string) => page.getByTestId(`notes-card-${id}`);
      await card('n1').waitFor({ timeout: 30000 });
      // 等电脑版换上（下载完、页里空闲时才换）
      await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="notes"] aside, [data-testid="notes"] [data-desk]') !== null || performance.now() > 4000)).toBe(true);
      await page.waitForTimeout(800);
      await drag(page, card('n3'), card('n1'), 4);
      await expect(page.getByTestId('notes-moved-toast')).toContainText('已切到自己排');
      await expect.poll(() => ids(page, 'notes-card-')).toEqual(['n3', 'n1', 'n2']);
    });
  });
});
