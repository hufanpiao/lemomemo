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
/**
 * 从现在起逐帧记，直到 stopRecord（不按固定时长停：机器慢时整段操作可能超过预定时长，最后一帧就不是落定以后的样子）。
 * 另用 16 ms 定时器记浮层在不在、卡片放大倍数（__recT）：CPU 吃紧或 CI 的 WebKit 一帧几百毫秒时 rAF 很稀（#129），
 * “浮层在、放大到 1.04”不能按 rAF 帧数判，按定时器采样的墙钟时长判
 */
function record(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __rec: unknown[]; __recT: unknown[]; __recStop: boolean };
    w.__rec = [];
    w.__recT = [];
    w.__recStop = false;
    const t0 = performance.now();
    const cardOf = (): HTMLElement | null | undefined => document.querySelector<HTMLElement>('[data-testid="sort-float"]')?.firstElementChild as HTMLElement | null | undefined;
    const tick = (): void => {
      const f = document.querySelector<HTMLElement>('[data-testid="sort-float"]');
      const card = f?.firstElementChild as HTMLElement | null | undefined;
      const rows: Record<string, { tf: string; top: number; seen: boolean }> = {};
      for (const e of document.querySelectorAll<HTMLElement>('[data-sort-id]:not([data-state="leaving"])')) {
        const cs = getComputedStyle(e);
        rows[e.dataset['sortId'] ?? ''] = { tf: cs.transform, top: e.getBoundingClientRect().top, seen: cs.visibility === 'visible' && Number(cs.opacity) > 0.05 };
      }
      w.__rec.push({ t: performance.now() - t0, float: !!f, card: card ? getComputedStyle(card).transform : '', rows });
      if (!w.__recStop && performance.now() - t0 < 30_000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const iv = setInterval(() => {
      const card = cardOf();
      w.__recT.push({ t: performance.now() - t0, float: !!card, card: card ? getComputedStyle(card).transform : '' });
      if (w.__recStop || performance.now() - t0 >= 30_000) clearInterval(iv);
    }, 16);
  });
}
/** 停止记录：再等两帧（落定以后的样子至少进 __rec 一帧）再停 */
async function stopRecord(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            (window as unknown as { __recStop: boolean }).__recStop = true;
            done();
          }),
        );
      }),
  );
}
const frames = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __rec: Frame[] }).__rec);
const samples = (page: Page): Promise<Pick<Frame, 't' | 'float' | 'card'>[]> =>
  page.evaluate(() => (window as unknown as { __recT: Pick<Frame, 't' | 'float' | 'card'>[] }).__recT);
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

/** ①②③：同 r429-sort-drag.spec.ts。smp 是定时器那一路的采样（浮层在不在、放大倍数），fr 是逐帧的 */
function checkFrames(fr: Frame[], smp: Pick<Frame, 't' | 'float' | 'card'>[], held: string, passed: readonly string[]): void {
  // 浮层一直在：拿起到松手至少 0.45 秒（拖到位以后还停了一下）。按墙钟算，不按帧数（原来“rAF 帧 > 5”，CPU 吃紧时 webkit 只来 5 帧，ci #495）
  const lifted = smp.filter((x) => x.float);
  const span = (lifted.at(-1)?.t ?? 0) - (lifted[0]?.t ?? 0);
  expect(span, `没有浮层：浮层采样 ${lifted.length} 次`).toBeGreaterThan(400);
  const liftedFr = fr.filter((x) => x.float);
  expect(Math.max(...[...lifted, ...liftedFr].map((x) => scaleOf(x.card)))).toBeGreaterThan(1.035);
  for (const id of passed) {
    expect(fr.some((x) => moved(x.rows[id]?.tf ?? 'none')), `${id} 没有让位动画`).toBe(true);
    expect(moved(fr.at(-1)?.rows[id]?.tf ?? 'none'), `${id} 最后没归零`).toBe(false);
  }
  const seen = fr.slice(fr.findIndex((x) => x.float && !x.rows[held]?.seen)).filter((x) => x.rows[held]?.seen);
  const final = seen.at(-1)?.rows[held]?.top ?? 0;
  expect(seen.filter((x) => x.float || Math.abs((x.rows[held]?.top ?? 0) - final) > 1), JSON.stringify(seen.slice(0, 20).map((x) => [Math.round(x.t), x.float, x.rows[held]?.top]))).toEqual([]);
}

/**
 * 在页面里记按下、头一次挪动、拿起的时刻，不靠测试这边的固定等待（机器慢时 waitForTimeout(150) 实际可能过了更久）。
 * “拿起”认浮层（sort-float）挂上 body 的那一刻：kit 拿起时在同一个任务里同步挂浮层（motion/sort-float.ts 的 liftFloat），
 * 行上的 data-sort-held 要等 React 重画，CPU 吃紧时会晚过 0.4 秒（11-22 本机加负载实测挪动到 data-sort-held 1187ms）。
 * 另记先后序号（不靠毫秒）：头一次挪动时起一个 LIFT_MS（400ms）的定时器，排在页面自己可能起的同长定时器前面；
 * 拿起的序号早于它（或它还没到点）= 挪了就拿起、没等 0.4 秒。CPU 吃紧时定时器也一起被拖，比的是先后，不是机器快慢
 */
function watchHold(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __hold: { down: number; move: number; held: number; seq: number; heldSeq: number; t400Seq: number } };
    w.__hold = { down: -1, move: -1, held: -1, seq: 0, heldSeq: -1, t400Seq: -1 };
    const h = w.__hold;
    document.addEventListener('pointerdown', () => (h.down = performance.now()), { capture: true, once: true });
    document.addEventListener('pointermove', () => {
      if (h.down < 0 || h.move >= 0) return;
      h.move = performance.now();
      setTimeout(() => (h.t400Seq = ++h.seq), 400);
    }, { capture: true });
    const mo = new MutationObserver(() => {
      if (document.querySelector('[data-testid="sort-float"]')) {
        h.held = performance.now();
        h.heldSeq = ++h.seq;
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true });
  });
}
/** 按下到拿起隔了多少毫秒（没记到是 -1） */
const holdMs = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const h = (window as unknown as { __hold: { down: number; held: number } }).__hold;
    return h.down < 0 || h.held < 0 ? -1 : h.held - h.down;
  });
/** 挪动以后拿起，早于挪动那一刻起的 400ms 定时器 */
const liftBeforeTimer = (page: Page): Promise<{ ok: boolean; at: string }> =>
  page.evaluate(() => {
    const h = (window as unknown as { __hold: { move: number; held: number; heldSeq: number; t400Seq: number } }).__hold;
    return {
      ok: h.heldSeq > 0 && (h.t400Seq < 0 || h.heldSeq < h.t400Seq),
      at: `拿起序号 ${h.heldSeq}、400ms 定时器序号 ${h.t400Seq}、挪动到拿起 ${Math.round(h.held - h.move)}ms`,
    };
  });

/** 松手以后等落定：运行日志有 settle（浮层撤掉）、被越过的行 transform 归零，再停止记录 */
async function settled(page: Page, tag: string, passed: readonly string[]): Promise<void> {
  await expect.poll(async () => (await runLog(page)).some((l) => new RegExp(` sort ${tag} settle `).test(l)), { timeout: 10_000 }).toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate((ids) => {
          if (document.querySelector('[data-testid="sort-float"]')) return false;
          return ids.every((id) => {
            const tf = getComputedStyle(document.querySelector(`[data-sort-id="${id}"]`) ?? document.body).transform;
            return tf === 'none' || tf === 'matrix(1, 0, 0, 1, 0, 0)';
          });
        }, passed),
      { timeout: 10_000 },
    )
    .toBe(true);
  await stopRecord(page);
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
    await watchHold(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(c).toHaveAttribute('data-sort-held', '');
    // 按下到拿起的间隔在页面里按事件时刻量（原来“等 0.15 秒看没拿起”：机器慢时那 0.15 秒实际可能过了 0.4 秒以上）
    expect(await holdMs(page), '按住不到 0.4 秒就拿起了').toBeGreaterThanOrEqual(400 - 20);
    const a = await card.locator('[data-sort-id="a"]').boundingBox();
    if (!a) throw new Error('找不到第一项');
    await page.mouse.move(a.x + a.width * 0.6, a.y + a.height * 0.3, { steps: 14 });
    await expect.poll(() => order(page)).toEqual(['c', 'a', 'b', 'd']);
    await page.waitForTimeout(450);
    await page.mouse.up();
    await settled(page, 'subs-todos', ['a', 'b']);
    checkFrames(await frames(page), await samples(page), 'c', ['a', 'b']);
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
    await watchHold(page);
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await expect(box.locator('[data-sort-id="c"]'), '轻点把手不拿起（评审第 8 条）').not.toHaveAttribute('data-sort-held', '');
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 5);
    await expect(box.locator('[data-sort-id="c"]'), '按住把手一挪就拿起').toHaveAttribute('data-sort-held', '');
    // 不用等 0.4 秒：拿起早于挪动那一刻起的 400ms 定时器（按先后判；原来测试这边只等 300 ms：机器慢时事件送达、重画本身就过了 300 ms）
    const lb = await liftBeforeTimer(page);
    expect(lb.ok, `挪了以后还等了 0.4 秒才拿起：${lb.at}`).toBe(true);
    const a = await box.locator('[data-sort-id="a"]').boundingBox();
    if (!a) throw new Error('找不到第一项');
    await page.mouse.move(g.x + g.width / 2, a.y + a.height * 0.3, { steps: 14 });
    await expect.poll(() => order(page)).toEqual(['c', 'a', 'b', 'd']);
    await page.waitForTimeout(450);
    await page.mouse.up();
    await settled(page, 'subs-edit', ['a', 'b']);
    checkFrames(await frames(page), await samples(page), 'c', ['a', 'b']);
    await expectLift(lift);
    await expect.poll(() => outboxOf(page)).toContain('todo_items:c:patch');
  });
});
