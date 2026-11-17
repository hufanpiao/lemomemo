// 长按拖动排序（R-429，含 R-433 拿起时左边的 6 个点）：不要后端，往本机库 planner-v4 写好行再重新载入，用鼠标“按住 0.5 秒 → 拖 → 松手”
// • 待办页（R-442 负责人“待办里面不需要拖动，只用HML来排序”，取代 R-429 的待办部分）：一组里按 H → M → L 排；按住 0.55 秒再拖不拿起——
//   没有浮层、没有横线、顺序不变、不写 outbox、运行日志里没有 sort 行
// • 随手记页（列表方式）：第一次拖 → “已切到自己排，设置里可改回”，不按天分组、顺序照放下的；设置 › 随手记显示方式里“随手记排序”是“自己排”，切回“按时间”恢复原顺序
// • 按住不到 0.4 秒就动：不拿起（没有横线）
// • 拿起（主持人 11-16 返工第 1、2 条）：原行留空位（看不见、高度照占），复制一份浮层挂在 body 上、带 6 个点；
//   落点横线上下 4px 内没有任何看得见的字（逐个文字节点量，浮层里的字也算）
// • 放下（返工第 5 条“先跳回原位再滑过去”）：从松手起逐帧记这一条的行，只要它看得见，浮层已经撤掉、位置就是最终位置（差 ≤ 1px）
// • 设了 LEMO_SHOT_DIR 时，Chromium 在拖动中各截一帧（430×932、DPR 3），给负责人看 6 个点和落点横线；LEMO_SHOT_THEME 给截图文件名加后缀（dark 开头时待办那段按系统深色跑）
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
  // 刚重新载入时行可能还没排版出来（boundingBox 为 null）
  // 载入后同步回来时列表会把行整个换成新元素，取位置恰好撞上会拿到 null：重试到两行都量得到
  type Box = { x: number; y: number; width: number; height: number };
  let boxes: [Box | null, Box | null] = [null, null];
  await expect(async () => {
    boxes = [await from.boundingBox(), await target.boundingBox()];
    expect(boxes[0] && boxes[1], '找不到行').toBeTruthy();
  }).toPass();
  const [a, b] = boxes;
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

/** 拿起：原行是空位（看不见、高度照占），浮层看得到 6 个点，落点横线显出来、上下 4px 内没有字 */
async function expectLifted(page: Page, row: Locator): Promise<void> {
  await expect(row).toHaveAttribute('data-sort-lifted', '');
  await expect(row).toHaveCSS('visibility', 'hidden');
  expect((await row.boundingBox())?.height ?? 0).toBeGreaterThan(40);
  const float = page.getByTestId('sort-float');
  await expect(float).toBeVisible();
  const grip = float.locator('[class*="grip"]');
  await expect(grip.locator('i')).toHaveCount(6);
  await expect.poll(() => grip.evaluate((e) => Number(getComputedStyle(e).opacity))).toBeGreaterThan(0.9);
  await expect(page.getByTestId('sort-line')).toBeVisible();
  // 浮层停稳（换落点时滑过去）再量
  await page.waitForTimeout(300);
  expect(await textNearLine(page)).toEqual([]);
}

/** 落点横线上下 4px 以内、横向和它重叠的看得见的字（返工第 1 条验收口径）；回这些字 */
function textNearLine(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="sort-line"]')?.getBoundingClientRect();
    if (!line) return ['没有横线'];
    const hit: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = (n.textContent ?? '').trim();
      const el = n.parentElement;
      if (!text || !el || getComputedStyle(el).visibility !== 'visible' || el.closest('[aria-hidden="true"]:not([data-testid="sort-float"])')) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const b of r.getClientRects()) {
        if (b.width === 0 || b.height === 0) continue;
        const across = b.right > line.left && b.left < line.right;
        if (across && b.bottom > line.top - 4 && b.top < line.bottom + 4) hit.push(text);
      }
    }
    return hit;
  });
}

/** 松手前调：从这一刻起逐帧记这一条的行（不算退场中的旧元素）看不看得见、在哪、浮层还在不在，记 1.5 秒 */
function watchSettle(page: Page, id: string): Promise<void> {
  return page.evaluate((sid) => {
    const w = window as unknown as { __settle: { t: number; float: boolean; top: number | null }[] };
    w.__settle = [];
    const t0 = performance.now();
    const tick = (): void => {
      const el = [...document.querySelectorAll<HTMLElement>(`[data-sort-id="${sid}"]`)].find((e) => e.style.position !== 'absolute');
      const cs = el ? getComputedStyle(el) : null;
      const seen = el && cs && cs.visibility === 'visible' && Number(cs.opacity) > 0.05;
      w.__settle.push({ t: performance.now() - t0, float: document.querySelector('[data-testid="sort-float"]') !== null, top: seen ? el.getBoundingClientRect().top : null });
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

/** watchSettle 记完以后：这一条只要看得见，浮层已经撤掉、位置就是最终位置（没有先回原位再滑过去） */
async function expectNoSnapBack(page: Page): Promise<void> {
  await page.waitForTimeout(1600);
  const s = await page.evaluate(() => (window as unknown as { __settle: { t: number; float: boolean; top: number | null }[] }).__settle);
  const seen = s.filter((x) => x.top !== null);
  expect(seen.length).toBeGreaterThan(0);
  const final = seen.at(-1)?.top ?? 0;
  const bad = seen.filter((x) => x.float || Math.abs((x.top ?? 0) - final) > 1);
  expect(bad, JSON.stringify(s.slice(0, 40))).toEqual([]);
}

async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (!SHOT_DIR || browserName !== 'chromium') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  const theme = process.env['LEMO_SHOT_THEME'];
  const look = await page.evaluate(() => `${document.documentElement.dataset['skin'] ?? '-'}/${document.documentElement.dataset['theme'] ?? '-'}`);
  await page.screenshot({ path: join(SHOT_DIR, `${name}${theme ? `-${theme}` : ''}.png`) });
  console.log(`shot ${name} skin/theme=${look}`);
}

test.describe('长按拖动排序（R-429、R-433）', () => {
  // 失败时把运行日志里拖动、左滑那几行打出来（先看日志定根因）
  test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) console.log((await runLog(page).catch(() => [])).filter((l) => /sort|swipe|hdrag/.test(l)).slice(-40).join('\n'));
  });

  test('R-442 待办页：一组里按 H → M → L 排；长按再拖不拿起、不改顺序、不写', async ({ page }) => {
    await page.goto('/app/#/todos');
    await page.waitForLoadState('domcontentloaded');
    const today = await dayOf(page, 0);
    await idbPut(page, [
      { ...todo, id: 't1', title: '低：给猫买猫砂', due: today, priority: 'low', created_at: 1 },
      { ...todo, id: 't2', title: '高：交报销单', due: today, priority: 'high', created_at: 2 },
      { ...todo, id: 't3', title: '中：准备提纲', due: today, priority: 'mid', created_at: 3 },
    ].map((r) => ['todos', cached(r)] as const));
    await page.reload();
    const row = (id: string) => page.getByTestId(`todos-row-${id}`);
    await row('t1').waitFor({ timeout: 30000 });
    const order = () => page.getByTestId('todos-g-today').locator('[data-testid^="todos-row-"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice(10)));
    await expect.poll(order).toEqual(['t2', 't3', 't1']);
    await expect(page.locator('[data-sort-id]')).toHaveCount(0);

    // 按住 0.55 秒（原来拿起的时长）再往上拖到第一行
    const a = await row('t1').boundingBox();
    const b = await row('t2').boundingBox();
    if (!a || !b) throw new Error('找不到行');
    await page.mouse.move(a.x + a.width * 0.45, a.y + a.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(550);
    await page.mouse.move(b.x + b.width * 0.45, b.y + 2, { steps: 12 });
    await expect(page.getByTestId('sort-float')).toHaveCount(0);
    await expect(page.getByTestId('sort-line')).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await order()).toEqual(['t2', 't3', 't1']);
    expect((await outboxOf(page)).filter((x) => x.startsWith('todos:'))).toEqual([]);
    expect((await runLog(page)).filter((l) => l.includes('sort todos'))).toEqual([]);
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
      await watchSettle(page, 'n3');
    });
    await expect(page.getByTestId('notes-moved-toast')).toContainText('已切到自己排，设置里可改回');
    await expectNoSnapBack(page);
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
