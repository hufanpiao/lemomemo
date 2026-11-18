// R-476 待办子任务拖动（负责人 11-18“待办子任务拖动时效果也要跟随手记拖动一样的动效”“在这里子代办也可以拖动”）：
// 随手记同一套 kit useSortDrag，逐帧量的标准照 r429-sort-drag.spec.ts 的 ①②③：
//   ① 拿起有过渡：浮层第一帧还没放大，之后放大到 1.04；② 被越过的行先让位（transform 非零）、最后归零；③ 松手以后这一项只要看得见，浮层已撤、位置就是最终位置
// • 待办页卡片：按住 0.55 秒拿起（不是当场），拖到第一项上面，顺序变、写进 outbox、日志有 sort subs-todos drop
// • 编辑页：按住左边把手一挪就拿起（不用等 0.4 秒；轻点不拿，评审第 8 条），拖到第一项上面，顺序变、写进 outbox
// 不要后端，往本机库 planner-v4 写好待办和子任务再重新载入（同 r350-subtasks.spec.ts）
import type { Locator, Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { runLog } from './fake-media.ts';
import { expectLift, installScrub, watchLift } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 430, height: 932 }, locale: 'zh-CN' });
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, rev: 1 };
/** 编辑页路由只认 UUID 形状的 id */
const T1 = '11111111-1111-4111-8111-111111111111';

async function seed(page: Page, at: string): Promise<void> {
  await page.goto(at);
  await page.waitForLoadState('domcontentloaded');
  const td = { ...base, id: T1, title: '去超市', due: today(), due_time: null, done: false, important: false, priority: 'mid', project: '', short: null, undone: false };
  const it = (id: string, title: string, sort: number) => ({ ...base, id, todo_id: T1, title, sort, done: false });
  await idbPut(page, [
    ['todos', cached(td)] as const,
    ...[it('a', '蔬菜', 1), it('b', '鸡蛋', 2), it('c', '水果', 3), it('d', '苹果', 4)].map((r) => ['todo_items', cached(r)] as const),
  ]);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
}

const order = (page: Page) => page.locator('[data-sort-id]:not([data-state="leaving"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-sort-id')));
const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

interface Frame {
  t: number;
  float: boolean;
  card: string;
  rows: Record<string, { tf: string; top: number; seen: boolean }>;
}
function record(page: Page, ms = 6000): Promise<void> {
  return page.evaluate((dur) => {
    const w = window as unknown as { __rec: unknown[] };
    w.__rec = [];
    const t0 = performance.now();
    const tick = (): void => {
      const f = document.querySelector<HTMLElement>('[data-testid="sort-float"]');
      const card = f?.firstElementChild as HTMLElement | null | undefined;
      const rows: Record<string, { tf: string; top: number; seen: boolean }> = {};
      for (const e of document.querySelectorAll<HTMLElement>('[data-sort-id]:not([data-state="leaving"])')) {
        const cs = getComputedStyle(e);
        rows[e.dataset['sortId'] ?? ''] = { tf: cs.transform, top: e.getBoundingClientRect().top, seen: cs.visibility === 'visible' && Number(cs.opacity) > 0.05 };
      }
      w.__rec.push({ t: performance.now() - t0, float: !!f, card: card ? getComputedStyle(card).transform : '', rows });
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}
const frames = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __rec: Frame[] }).__rec);
const scaleOf = (tf: string): number => (tf.startsWith('matrix(') ? Number(tf.slice(7).split(',')[0]) : 1);
const moved = (tf: string): boolean => tf !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(tf);

/** 位置连着两次不变再按（载入后列表上面还会出东西把整列往下推） */
async function steady(page: Page, el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let a = await el.boundingBox();
  await expect.poll(async () => {
    const p = JSON.stringify(a);
    await page.waitForTimeout(150);
    a = await el.boundingBox();
    return a !== null && JSON.stringify(a) === p;
  }).toBe(true);
  if (!a) throw new Error('找不到');
  return a;
}

/** ①②③：同 r429-sort-drag.spec.ts */
function checkFrames(fr: Frame[], held: string, passed: readonly string[]): void {
  const lifted = fr.filter((x) => x.float);
  expect(lifted.length, '没有浮层').toBeGreaterThan(5);
  expect(Math.max(...lifted.map((x) => scaleOf(x.card)))).toBeGreaterThan(1.035);
  for (const id of passed) {
    expect(fr.some((x) => moved(x.rows[id]?.tf ?? 'none')), `${id} 没有让位动画`).toBe(true);
    expect(moved(fr.at(-1)?.rows[id]?.tf ?? 'none'), `${id} 最后没归零`).toBe(false);
  }
  const seen = fr.slice(fr.findIndex((x) => x.float && !x.rows[held]?.seen)).filter((x) => x.rows[held]?.seen);
  const final = seen.at(-1)?.rows[held]?.top ?? 0;
  expect(seen.filter((x) => x.float || Math.abs((x.rows[held]?.top ?? 0) - final) > 1), JSON.stringify(seen.slice(0, 20).map((x) => [Math.round(x.t), x.float, x.rows[held]?.top]))).toEqual([]);
}

test.describe('R-476 待办子任务拖动（随手记同一套）', () => {
  test.setTimeout(60_000);
  test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) console.log((await runLog(page).catch(() => [])).filter((l) => /sort|route/.test(l)).slice(-40).join('\n'));
  });

  test('待办页卡片：按住 0.4 秒才拿起；拖到第一项上面，让位、放下不跳，顺序变、写进 outbox', async ({ page }) => {
    await seed(page, '/app/#/todos');
    const card = page.getByTestId(`todos-subs-${T1}`);
    await card.waitFor({ timeout: 30000 });
    await expect.poll(() => order(page)).toEqual(['a', 'b', 'c', 'd']);
    const c = card.locator('[data-sort-id="c"]');
    const b = await steady(page, c);
    const x = b.x + b.width * 0.6;
    const y = b.y + b.height / 2;
    await installScrub(page);
    const lift = watchLift(page);
    await record(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await expect(c, '0.15 秒还不该拿起').not.toHaveAttribute('data-sort-held', '');
    await page.waitForTimeout(400);
    await expect(c).toHaveAttribute('data-sort-held', '');
    const a = await card.locator('[data-sort-id="a"]').boundingBox();
    if (!a) throw new Error('找不到第一项');
    await page.mouse.move(a.x + a.width * 0.6, a.y + a.height * 0.3, { steps: 14 });
    await page.waitForTimeout(450);
    expect(await order(page)).toEqual(['c', 'a', 'b', 'd']);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    checkFrames(await frames(page), 'c', ['a', 'b']);
    await expectLift(lift);
    await expect.poll(() => order(page)).toEqual(['c', 'a', 'b', 'd']);
    await expect.poll(() => outboxOf(page)).toContain('todo_items:c:patch');
    expect((await runLog(page)).some((l) => / sort subs-todos drop i=2 to=0 n=4/.test(l)), (await runLog(page)).filter((l) => l.includes('sort')).join('\n')).toBe(true);
  });

  test('编辑页：按住把手一挪就拿起（轻点不拿）；拖到第一项上面，顺序变、写进 outbox', async ({ page }) => {
    await seed(page, `/app/#/todo/${T1}`);
    const box = page.getByTestId('todo-subs');
    await box.waitFor({ timeout: 30000 });
    await expect.poll(() => order(page)).toEqual(['a', 'b', 'c', 'd']);
    const grip = box.locator('[data-sort-id="c"] [data-sort-grip]');
    const g = await steady(page, grip);
    await installScrub(page);
    const lift = watchLift(page);
    await record(page);
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await expect(box.locator('[data-sort-id="c"]'), '轻点把手不拿起（评审第 8 条）').not.toHaveAttribute('data-sort-held', '');
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 5);
    await expect(box.locator('[data-sort-id="c"]'), '按住把手一挪就拿起，不用等 0.4 秒').toHaveAttribute('data-sort-held', '', { timeout: 300 });
    const a = await box.locator('[data-sort-id="a"]').boundingBox();
    if (!a) throw new Error('找不到第一项');
    await page.mouse.move(g.x + g.width / 2, a.y + a.height * 0.3, { steps: 14 });
    await page.waitForTimeout(450);
    expect(await order(page)).toEqual(['c', 'a', 'b', 'd']);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    checkFrames(await frames(page), 'c', ['a', 'b']);
    await expectLift(lift);
    await expect.poll(() => outboxOf(page)).toContain('todo_items:c:patch');
  });
});
