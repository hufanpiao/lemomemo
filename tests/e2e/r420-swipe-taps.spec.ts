// 横滑手势、吞点按的真浏览器用例（R-420 第三方审查二轮“横滑手势、吞点按、草稿框”）：jsdom 量不出动画和焦点，这里在 chromium、webkit 上守
//   ① 月历翻页逐帧（审查第 2 条；R-457 负责人 11-17 选“放慢4倍的C原地淡换”）：按钮翻页、手指横滑翻页以后，每一帧读
//      新的一页（cal-pager）的计算透明度和横移、旧的一页副本（叠在原位、aria-hidden）在不在和它的透明度：
//      第一帧副本叠着、新的一页还没完全显出来；新的一页一路变实、副本一路变淡，至少 1 帧停在半路；横移从头到尾不超过跟手的那一小段（不整页滑）；
//      最后副本撤掉、新的一页不透明。报错信息带每帧的时间，帧间隔从日志直接看
//   ② 翻不动也不播翻页动画（审查第 1 条）：到 2100 年 12 月再往左滑，松手只滑回原位（每一帧都 ≤ 0，不会从右边整页滑进来），也不拍副本
//   ③ 一行露着时点另一行（审查第 7 条）：第一下只收起露着的那行，不打开点到的那行；再点一下才打开
//   ④ 滑开后焦点在操作按钮上按 Esc 收起（审查第 6 条）：焦点交还给行面的主按钮，不掉回 body
//   ⑤ 左滑完马上在行面按 Enter（审查第 12 条）：键盘的 click（detail 为 0）不当成滑完补来的那一下，照常打开
// 手指横滑用页面里派发的 PointerEvent（pointerType touch）：webkit 没有 CDP 触摸，月历翻页又不认鼠标；
// 逐帧数据设了 LEMO_FRAMES_OUT 就写成 JSON（只给审查记录用），断言不靠它
import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { FOLLOW_MAX_PX } from '../../src/motion/swipe-pager.ts';
import { expect, test } from './session-fixture.ts';

test.use({ trace: 'off', loggedIn: true, viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const FRAMES_OUT = process.env['LEMO_FRAMES_OUT'];
const frameLog: Record<string, number[]> = {};
test.afterAll(({ browserName }) => {
  if (FRAMES_OUT && Object.keys(frameLog).length > 0) writeFileSync(`${FRAMES_OUT}-${browserName}.json`, JSON.stringify(frameLog, null, 1));
});

type Act = { kind: 'next' } | { kind: 'swipe'; dx: number };

/** 每帧：新的一页的横移（px，取整）、透明度（两位小数）、副本的透明度（没有副本 null）、离第一帧的毫秒数；diag 第一帧时的诊断 */
type Frames = { x: number[]; op: number[]; ghost: (number | null)[]; ms: number[]; diag: string };
async function framesAfter(page: Page, act: Act): Promise<Frames> {
  return page.evaluate(async (a) => {
    const el = document.querySelector<HTMLElement>('[data-testid="cal-pager"]');
    if (!el) throw new Error('no pager');
    const tx = (): number => {
      const m = getComputedStyle(el).transform;
      // 快到终点时是 -0.3 这类小数，取整得 -0，归成 0
      return m === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(m).m41) || 0;
    };
    if (a.kind === 'next') {
      document.querySelector<HTMLElement>('[data-testid="cal-next"]')?.click();
    } else {
      const r = el.getBoundingClientRect();
      const y = r.top + 120;
      const x0 = r.left + r.width / 2 + (a.dx < 0 ? 80 : -80);
      const fire = (type: string, x: number): void =>
        void el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      fire('pointerdown', x0);
      for (let i = 1; i <= 5; i++) fire('pointermove', x0 + (a.dx * i) / 5);
      // 跟手画一帧再松手（真手指松手前总有几帧在跟手）
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      fire('pointerup', x0 + a.dx);
    }
    const x: number[] = [];
    const op: number[] = [];
    const ghost: (number | null)[] = [];
    const ms: number[] = [];
    let diag = '';
    let t0: number | undefined;
    const ghostEl = (): HTMLElement | null => {
      const g = el.previousElementSibling;
      return g instanceof HTMLElement && g.getAttribute('aria-hidden') === 'true' ? g : null;
    };
    const opOf = (e: Element): number => Math.round(Number(getComputedStyle(e).opacity) * 100) / 100;
    await new Promise<void>((res) => {
      const tick = (now: number): void => {
        const g = ghostEl();
        if (x.length === 0) {
          diag = [`connected=${el.isConnected}`, `ghost=${g !== null}`, `anims=${el.getAnimations().length}`, `rm=${document.documentElement.dataset['rm'] ?? '-'}`].join(' ');
        }
        x.push(tx());
        op.push(opOf(el));
        ghost.push(g ? opOf(g) : null);
        t0 ??= now;
        ms.push(Math.round(now - t0));
        // 至少 16 帧，并且采到副本撤掉、新的一页不透明、回到原位为止（最多 6 秒）
        const rest = g === null && op.at(-1) === 1 && x.at(-1) === 0;
        if ((x.length < 16 || !rest) && now - t0 < 6000) requestAnimationFrame(tick);
        else res();
      };
      requestAnimationFrame(tick);
    });
    return { x, op, ghost, ms, diag };
  }, act);
}

/** 逐帧时把 --dur-ui 调长（只在这个页面、用 CSSOM 改根节点，不插 <style>，不触发 CSP）：翻不动时“滑回原位”是 CSS 过渡，
 *  CI 的 WebKit 软件渲染一帧 240～580 ms，比 0.22 s 的过渡还长（分诊表遗留⑤）。翻页淡换是 JS 动画（--dur-ui × 4 = 880 ms），不受它影响 */
const SLOW_DUR = '1500ms';

async function openMonth(page: Page, ym: string): Promise<void> {
  await page.goto(`/app/#/cal/month/${ym}`);
  await expect(page.getByTestId('cal-pager')).toBeVisible({ timeout: 30_000 });
  await page.evaluate((d) => document.documentElement.style.setProperty('--dur-ui', d), SLOW_DUR);
  // 换页后 FADE_GUARD_MS 以内落在 main 里的点按按设计吞掉（motion/index.ts 的 guardTaps）
  await page.waitForTimeout(FADE_GUARD_MS + 200);
}

/** 原地淡换：第一帧副本叠着、新的一页没完全显出来；新的一页一路不变淡、副本一路不变实，至少 1 帧半路；横移不超过跟手那一小段；最后副本撤掉、不透明 */
function expectCrossFade(fr: Frames, what: string): void {
  const seen = `（每帧 x=${fr.x.join(',')}，op=${fr.op.join(',')}，副本=${fr.ghost.map((g) => g ?? '-').join(',')}，ms=${fr.ms.join(',')}；第一帧 ${fr.diag}）`;
  expect(fr.ghost[0], `${what} 第一帧旧的一页副本叠在原位${seen}`).not.toBeNull();
  expect(fr.op[0], `${what} 第一帧新的一页还没完全显出来${seen}`).toBeLessThan(1);
  for (let i = 1; i < fr.op.length; i++) expect(fr.op[i], `${what} 第 ${i} 帧新的一页不往回变淡${seen}`).toBeGreaterThanOrEqual((fr.op[i - 1] as number) - 0.01);
  const g = fr.ghost.filter((v): v is number => v !== null);
  for (let i = 1; i < g.length; i++) expect(g[i], `${what} 副本不往回变实${seen}`).toBeLessThanOrEqual((g[i - 1] as number) + 0.01);
  expect(fr.op.filter((o) => o > 0 && o < 1).length, `${what} 真的在淡换（半路的帧）${seen}`).toBeGreaterThanOrEqual(1);
  for (const [i, x] of fr.x.entries()) expect(Math.abs(x), `${what} 第 ${i} 帧不整页横移${seen}`).toBeLessThanOrEqual(FOLLOW_MAX_PX);
  expect(fr.ghost.at(-1), `${what} 最后副本撤掉${seen}`).toBeNull();
  expect(fr.op.at(-1), `${what} 最后不透明`).toBe(1);
  expect(fr.x.at(-1), `${what} 最后回到原位`).toBe(0);
}

test.describe('月历翻页逐帧（R-420 审查第 1、2 条）', () => {
  test('按钮翻页、手指横滑翻页：原地淡换（旧页副本淡出、新页淡入），不整页横移', async ({ page }) => {
    await openMonth(page, '2026-11');
    const byButton = await framesAfter(page, { kind: 'next' });
    frameLog['按钮下一页'] = byButton.op;
    expectCrossFade(byButton, '按钮下一页');
    await page.waitForTimeout(400);
    const bySwipe = await framesAfter(page, { kind: 'swipe', dx: -100 });
    frameLog['左滑 100 下一页'] = bySwipe.op;
    expectCrossFade(bySwipe, '左滑 100 下一页');
    await expect(page).toHaveURL(/2027-01/);
  });

  test('翻不动（2100 年 12 月再往后）：松手只滑回原位，不从右边整页滑进来、不淡换', async ({ page }) => {
    await openMonth(page, '2100-12');
    const fr = await framesAfter(page, { kind: 'swipe', dx: -100 });
    const f = fr.x;
    frameLog['2100-12 左滑 100（翻不动）'] = f;
    for (const [i, x] of f.entries()) expect(x, `第 ${i} 帧不在右边`).toBeLessThanOrEqual(0);
    expect(f.at(-1)).toBe(0);
    expect(fr.ghost.filter((g) => g !== null), '翻不动不拍副本').toEqual([]);
    await expect(page).toHaveURL(/2100-12/);
  });
});

const ROW_A = '0e2e0000-0000-4000-8000-0000000c4201';
const ROW_B = '0e2e0000-0000-4000-8000-0000000c4202';

/** 本机库 anniversaries 仓写两行（同 b5-anniv.spec.ts 的写法）：A 在前（10 天后）、B 在后（20 天后） */
async function seedTwo(page: Page): Promise<void> {
  const now = Date.now();
  const day = (n: number): { m: number; d: number; date: string } => {
    const t = new Date(now + n * 86_400_000);
    return { m: t.getUTCMonth() + 1, d: t.getUTCDate(), date: t.toISOString().slice(0, 10) };
  };
  const a = day(10);
  const b = day(20);
  const base = { kind: 'anniversary', calendar: 'solar', lunar_variant: 'cn', is_leap: false, after_due: 'archive', remind_offsets: null, remind_time: null, avatar_id: null, note: '',
    remind_at: null, snooze_at: null, notified_for: null, archived_at: null, deleted_at: null, undone: false, rev: 1, created_at: now - 86_400_000, updated_at: now, year: 2020 };
  const rows = [
    { ...base, id: ROW_A, name: '甲', month: a.m, day: a.d, next_date: a.date },
    { ...base, id: ROW_B, name: '乙', month: b.m, day: b.d, next_date: b.date },
  ];
  await page.evaluate(
    (rs) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onerror = () => reject(new Error(String(req.error)));
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['anniversaries'], 'readwrite');
          for (const r of rs) tx.objectStore('anniversaries').put({ id: r.id, server: r, view: r });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error(String(tx.error)));
        };
      }),
    rows,
  );
}

/** 鼠标在行上往左拖 dx（同 b5-anniv.spec.ts 的 swipeLeft；列表行电脑上认鼠标） */
async function mouseSwipe(page: Page, row: Locator, dx: number): Promise<void> {
  const box = await row.boundingBox();
  if (!box) throw new Error('no box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 30, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 30 + dx / 2, y + 2, { steps: 5 });
  await page.mouse.move(box.x + box.width - 30 + dx, y + 2, { steps: 5 });
  await page.mouse.up();
}

/** 手指在行面上左滑 dx（页面里派发 touch 的 PointerEvent，后面不会跟浏览器补的 click） */
async function touchSwipe(row: Locator, dx: number): Promise<void> {
  await row.evaluate((li, d) => {
    const face = li.firstElementChild as HTMLElement;
    const r = face.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const x0 = r.right - 40;
    const fire = (type: string, x: number): void =>
      void face.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    fire('pointerdown', x0);
    for (let i = 1; i <= 5; i++) fire('pointermove', x0 + (d * i) / 5);
    fire('pointerup', x0 + d);
  }, dx);
}

test.describe('左滑行（R-420 审查第 6、7、12 条）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/#/anniv');
    await expect(page.getByTestId('anniv-mode-anniv')).toBeVisible({ timeout: 30_000 });
    await seedTwo(page);
    await page.reload();
    await expect(page.getByTestId('anniv-list').getByTestId('anniv-row')).toHaveCount(2, { timeout: 30_000 });
    await page.waitForTimeout(FADE_GUARD_MS + 200);
  });

  test('一行露着时点另一行：第一下只收起，不打开；再点一下才打开', async ({ page }) => {
    const rows = page.getByTestId('anniv-list').getByTestId('anniv-row');
    await mouseSwipe(page, rows.nth(0), -130);
    await expect(rows.nth(0)).toHaveAttribute('data-swipe', 'open');
    await rows.nth(1).locator('button').first().click();
    await expect(rows.nth(0)).not.toHaveAttribute('data-swipe', 'open');
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/#\/anniv$/);
    await rows.nth(1).locator('button').first().click();
    await expect(page).toHaveURL(new RegExp(`#/anniv/${ROW_B}$`));
  });

  test('滑开后焦点在“编辑”上按 Esc：收起，焦点回到行面的主按钮', async ({ page }) => {
    const rows = page.getByTestId('anniv-list').getByTestId('anniv-row');
    await mouseSwipe(page, rows.nth(0), -130);
    await expect(rows.nth(0)).toHaveAttribute('data-swipe', 'open');
    await rows.nth(0).getByTestId('anniv-swipe-edit').focus();
    await page.keyboard.press('Escape');
    await expect(rows.nth(0)).not.toHaveAttribute('data-swipe', 'open');
    const onMain = await rows.nth(0).evaluate((li) => document.activeElement !== null && document.activeElement === li.firstElementChild?.querySelector('button'));
    expect(onMain, '焦点在行面的主按钮上').toBe(true);
  });

  test('手指左滑一点（收回）后马上在行面按 Enter：照常打开（键盘的 click 不吞）', async ({ page }) => {
    const rows = page.getByTestId('anniv-list').getByTestId('anniv-row');
    await touchSwipe(rows.nth(0), -40);
    await expect(rows.nth(0)).not.toHaveAttribute('data-swipe', 'open');
    await rows.nth(0).locator('button').first().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/anniv/${ROW_A}$`));
  });
});
