// 待办勾选完成时间线（负责人 11-17：“现在我的动效太轻了，根本反应不过来，并且完成时的横线是从左到右画上去的”；“这个间距太挤了”）。
// 不要后端：直接往本机库 planner-v4 写好待办和子任务再重新载入，待办页逐帧取样（每个 rAF 一次）：
// • 删除线（kit TodoRow 标题里的 .line，scaleX）从 0 单调长到 1，起步不早于 --dur-done-strike-at 的一半（不和方框同一拍）、900 ms 内画满
// • 方框（kit CheckCircle 的 .checkBox）放大峰值不低于 1.25（参考视频第 4–5 帧约 1.3 倍），最后回到 1
// • 打上 data-out 以后这一行在 --dur-collapse（100 ms）加两帧余量内收完、离开原组
// • 减弱动态效果：方框不缩放、不炸开，删除线直接画满，没有中间值
// • 间距：标题和副行之间、副行和展开后的第一条子任务之间各至少留 3.5 / 13 px（负责人“太挤了”时是 0 / 10 px）
// • 字号：待办行副行（带子任务的“起步 · 1/3”胶囊和普通行的“工作”）和页头“· 0 / 3 完成”同一档（负责人 11-17 17:31“整体在小一圈”）
// • 环境变量 DONE_SHOTS 指一个本机文件夹时（只在 Chromium），截 430×932、DPR 3 的浅色、深色各一张，加勾选特效的关键帧连拍，不进仓库
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const SHOTS = process.env['DONE_SHOTS'];
test.use({ loggedIn: true, timezoneId: TZ, locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, rev: 1, undone: false, short: null };
const T1 = '11111111-1111-4111-8111-111111111111';

/** 没有日期的三条：T1“整理旧照片”带三项子任务（勾了一项），t2“回邮件”（项目“工作”，副行是普通的那种）、t3 没有子任务 */
async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  const td = (id: string, title: string, priority: string, project = '') => ({ ...base, id, title, project, due: null, due_time: null, done: false, important: false, priority });
  const it = (id: string, title: string, sort: number, done: boolean) => ({ ...base, id, todo_id: T1, title, sort, done });
  await idbPut(page, [
    ...[td(T1, '整理旧照片', 'high'), td('t2', '回邮件', 'mid', '工作'), td('t3', '买猫砂', 'low')].map((r) => ['todos', cached(r)] as const),
    ...[it('a', '挑出要冲印的', 1, true), it('b', '备份到硬盘', 2, false), it('c', '删掉重复的', 3, false)].map((r) => ['todo_items', cached(r)] as const),
  ]);
  await page.reload();
  await page.getByTestId(`todos-subs-${T1}`).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30000 });
  await page.waitForTimeout(400);
}

/** [距点下毫秒, 删除线 scaleX, 方框 scale, 行在不在原组（1/0）, 行上有没有 data-out（1/0）] */
type F = [number, number | null, number | null, number, number];

/** 点 id 那一行的方框，从 pointerdown 起逐帧记 1200 ms */
async function record(page: Page, id: string): Promise<F[]> {
  await page.evaluate((id) => {
    type W = Window & { __f?: unknown[] };
    const w = window as W;
    w.__f = [];
    const scaleOf = (el: Element | null | undefined): number | null => {
      if (!el) return null;
      const t = getComputedStyle(el).transform;
      if (t === 'none') return 1;
      const m = /matrix\(([^,]+),\s*([^,]+)/.exec(t);
      return m ? Math.hypot(Number(m[1]), Number(m[2])) : null;
    };
    let t0 = 0;
    const tick = (): void => {
      const dt = performance.now() - t0;
      const row = document.querySelector(`[data-row-id="${id}"]:not([data-state="leaving"])`);
      w.__f?.push([
        dt,
        scaleOf(row?.querySelector('[class*="line"][aria-hidden]')),
        scaleOf(row?.querySelector('label[class*="checkBox"]')),
        row ? 1 : 0,
        row?.hasAttribute('data-out') ? 1 : 0,
      ]);
      if (dt < 1200) requestAnimationFrame(tick);
    };
    document.addEventListener(
      'pointerdown',
      () => {
        t0 = performance.now();
        requestAnimationFrame(tick);
      },
      { once: true, capture: true },
    );
  }, id);
  await page.getByTestId(`todos-done-${id}`).click();
  await expect.poll(() => page.evaluate(() => ((window as Window & { __f?: F[] }).__f ?? []).at(-1)?.[0] ?? 0), { timeout: 5000 }).toBeGreaterThanOrEqual(1200);
  return (await page.evaluate(() => (window as Window & { __f?: unknown[] }).__f ?? [])) as F[];
}

const show = (f: F[]): string => f.map(([t, l, b, r, o]) => `${t.toFixed(0)}:${l?.toFixed(2) ?? '-'}/${b?.toFixed(2) ?? '-'}/${r}${o}`).join(' ');

test.describe('待办勾选完成时间线', () => {
  test('删除线从左往右单调画满、方框放大过头 ≥ 1.25 再回 1、收起在 --dur-collapse 内完成', async ({ page }) => {
    await seed(page);
    const f = await record(page, 't2');
    const trace = show(f);
    const lines = f.map((x) => x[1]).filter((x): x is number => x !== null);
    expect(lines.length, `取样不够：${trace}`).toBeGreaterThan(5);
    // ① 删除线：单调不减、最后画满；起步晚于方框（等 --dur-done-strike-at，170 ms），不是一点下去就画了一半
    for (let k = 1; k < lines.length; k += 1) expect(lines[k]!, `删除线往回缩：${trace}`).toBeGreaterThanOrEqual(lines[k - 1]! - 0.01);
    expect(lines.at(-1)!, `删除线没画满：${trace}`).toBeGreaterThan(0.99);
    const early = f.filter((x) => x[0] < 80 && x[1] !== null && x[1] > 0.05);
    expect(early, `删除线和方框同一拍就起步了：${trace}`).toEqual([]);
    const mid = lines.filter((x) => x > 0.05 && x < 0.95);
    expect(mid.length, `删除线没有中间帧（一下子画满，不是从左往右画）：${trace}`).toBeGreaterThan(0);
    // ② 方框放大过头不低于 1.25，最后回到 1
    const boxes = f.map((x) => x[2]).filter((x): x is number => x !== null);
    expect(Math.max(...boxes), `方框放大峰值不够：${trace}`).toBeGreaterThanOrEqual(1.25);
    // ③ 打上 data-out 以后 100 ms（--dur-collapse）加 3 帧余量内离开原组
    const outAt = f.find((x) => x[4] === 1)?.[0];
    expect(outAt, `1200 ms 里没开始收起：${trace}`).toBeDefined();
    const goneAt = f.find((x) => x[3] === 0)?.[0];
    expect(goneAt, `1200 ms 里没收完：${trace}`).toBeDefined();
    expect(goneAt! - outAt!, `收起太慢：${trace}`).toBeLessThanOrEqual(100 + 3 * 34);
    const beforeOut = boxes.slice(0, f.findIndex((x) => x[4] === 1)).at(-1);
    expect(beforeOut!, `收起前方框没回到 1：${trace}`).toBeLessThan(1.02);
  });

  test('减弱动态效果：方框不缩放、删除线直接画满（没有中间帧）', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seed(page);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-rm') === '1', undefined, { timeout: 10000 });
    const f = await record(page, 't2');
    const trace = show(f);
    const boxes = f.map((x) => x[2]).filter((x): x is number => x !== null);
    expect(Math.max(...boxes), `减弱动态效果时方框还在放大：${trace}`).toBeLessThan(1.01);
    const mid = f.map((x) => x[1]).filter((x): x is number => x !== null && x > 0.05 && x < 0.95);
    expect(mid, `减弱动态效果时删除线还在过渡：${trace}`).toEqual([]);
  });

  test('间距：标题和副行之间、副行和展开后的第一条子任务之间都留出空', async ({ page, browserName }) => {
    await seed(page);
    const g = await page.evaluate((id) => {
      const row = document.querySelector(`[data-row-id="${id}"]`);
      const title = row?.querySelector('[class*="title"]')?.getBoundingClientRect();
      const stage = document.querySelector(`[data-testid="todos-stage-${id}"]`)?.getBoundingClientRect();
      const first = document.querySelector('[data-testid="todos-sub-a"]')?.closest('li');
      const box = first?.querySelector('label')?.getBoundingClientRect();
      return title && stage && box ? { titleToMeta: stage.top - title.bottom, metaToSub: box.top - stage.bottom } : null;
    }, T1);
    expect(g).not.toBeNull();
    console.log(`间距 ${browserName}：标题→副行 ${g!.titleToMeta.toFixed(1)}px，副行→第一条子任务方框 ${g!.metaToSub.toFixed(1)}px`);
    expect(g!.titleToMeta).toBeGreaterThanOrEqual(3.5);
    expect(g!.metaToSub).toBeGreaterThanOrEqual(13);
    // 字号：页头那一行、带子任务的副行（胶囊里的字、“1/3”）、普通行的副行一样大
    const fs = await page.evaluate((id) => {
      const px = (el: Element | null | undefined): string => (el ? getComputedStyle(el).fontSize : '-');
      const stage = document.querySelector(`[data-testid="todos-stage-${id}"]`);
      return { head: px(document.querySelector('[data-testid="todos-sub"]')), pill: px(stage?.querySelector('[data-stage]')), frac: px(stage?.lastElementChild), plain: px(document.querySelector('[data-testid="todos-tag-t2"]')) };
    }, T1);
    console.log(`字号 ${browserName}：${JSON.stringify(fs)}`);
    expect(fs).toEqual({ head: '11px', pill: '11px', frac: '11px', plain: '11px' });
    if (!SHOTS || browserName !== 'chromium') return;
    const clip = await page.getByTestId(`todos-row-${T1}`).boundingBox();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/间距_${scheme === 'light' ? '浅色' : '深色'}.png` });
      if (clip) await page.screenshot({ path: `${SHOTS}/间距_${scheme === 'light' ? '浅色' : '深色'}_行放大.png`, clip: { x: 0, y: Math.max(0, clip.y - 24), width: 430, height: clip.height + 40 } });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  test('关键帧连拍（只在 DONE_SHOTS 设了、Chromium 时截图）', async ({ page, browserName }) => {
    test.skip(!SHOTS || browserName !== 'chromium', '只在要截图时跑');
    await seed(page);
    const row = page.getByTestId('todos-row-t2');
    const box = (await row.boundingBox())!;
    const clip = { x: 0, y: box.y - 12, width: 430, height: box.height + 24 };
    // 连拍要几秒：把 HOLD_MS（--dur-done-pop + --dur-done-rest）那一下的计时（≥ 700 ms 的 setTimeout）推到很久以后，免得拍到一半这一行就收起来了
    await page.evaluate(() => {
      const raw = window.setTimeout.bind(window);
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => raw(fn, (ms ?? 0) >= 700 ? 1e9 : ms, ...rest)) as typeof window.setTimeout;
    });
    await page.getByTestId('todos-done-t2').click();
    // 停在勾上那一刻，按参考视频的帧（30fps）把所有 CSS 动画、过渡拨到同一时刻再截
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.pause();
    });
    for (const [n, ms] of [[1, 33], [2, 67], [3, 100], [4, 133], [5, 167], [6, 200], [7, 233], [9, 300], [11, 367], [13, 433]] as const) {
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) a.currentTime = ms;
      }, ms);
      await page.waitForTimeout(60);
      await page.screenshot({ path: `${SHOTS}/关键帧_f${String(n).padStart(2, '0')}_${ms}ms.png`, clip });
    }
  });
});
