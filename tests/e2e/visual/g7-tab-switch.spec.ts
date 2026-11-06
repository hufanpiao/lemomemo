// 视觉基准 G7（docs/06-测试/负责人观感要求清单.md，负责人 11-06：“底部栏切换的时候这样，这是怎么通过的？”（叠字）；
// “导航栏有不透明再变透明的情况”）：今天 ↔ 待办互切，按 0%、20%、40%、60%、100% 截帧。
// 推帧做法照 b2-tabbar-transition.spec.ts：点页签以后每一帧把新出现的动画（main 的淡入、液滴的过渡、View Transition 的伪元素）
// 当场暂停、记下出现的时刻，全部到齐以后按“整段过渡的总时长 × 百分比”把每个动画拨到对应的 currentTime 截图。
// 100% 那一帧：把动画全部放完（View Transition 结束、data-vt 摘掉），再等 3 帧，这时新起的动画（比如过渡结束后底栏遮罩淡回玻璃）
// 停在开头截——“先实心再透明”就出在这一刻。
// 每一帧判两样：
//   • 不叠字（像素判）：内容区（顶部模糊带以下、底部渐变带以上）每一帧拟合成“旧页 × a + 新页 × b”（都先减去只有底色的那一张），
//     a、b 都超过 G7_OVERLAP 就是叠字。不用 DOM 判：9d40848 上 20% 那一帧新旧两页明明叠在一起，
//     getComputedStyle 读 ::view-transition-old/new(root) 的不透明度却是 0.12 / 0（webkit 读暂停中伪元素的动画值不可靠）。DOM 读数照样记进报告；
//   • 底栏是透明玻璃：底栏范围内 D = A − B（B 藏掉内容）的标准差 ÷ 同一帧上方空旷处内容的 D 标准差（透过率）不低于 G7_MIN_TRANSMIT。
//     用透过率不用绝对方差：切页中途新页本身还淡着（0%、20% 时不透明度很低），后面的字本来就淡，绝对值小不说明底栏实心；
//     上方空旷处内容几乎看不见（D 标准差 < G7_REF_MIN）的帧没东西可透，只记数、不判。
import { writeFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { grab, meanVar, mix, pillCore, r2, type Rect, rectOf, sub } from './pixels.ts';
import { applyTheme, expect, frames, freeze, hideContent, seedTodos, settle, test } from './visual-helpers.ts';

/**
 * 透过率下限：静止时 9d40848（底栏透明）底栏 D 12.5～29、上方内容 D 约 40，透过率 0.3～0.7；69659c1（底栏后面实色）是 0。
 * 9d40848 切页中（View Transition 里底栏是实色快照）0%～60% 实测 0。取 0.05
 */
export const G7_MIN_TRANSMIT = 0.05;
/** 上方参考区内容的 D 标准差低于它，这一帧当“没有字可透”，不判透过率 */
export const G7_REF_MIN = 3;
/** 叠字：旧页、新页的拟合系数都超过它。9d40848 的 20% 帧旧页残影 0.11，黑字在浅底上肉眼清楚看得见，所以门槛压到 0.05
 *（没叠的帧拟合出来的另一页系数实测 ≤ 0.01） */
export const G7_OVERLAP = 0.05;
const PCTS = [0, 0.2, 0.4, 0.6, 1] as const;

type Theme = 'light' | 'dark';
const themeOf = (ti: TestInfo): Theme => (ti.project.use.colorScheme === 'dark' ? 'dark' : 'light');

/** 点页签，把这次切页起的动画逐个暂停、记下出现时刻（相对点按，毫秒）和各自的结束时刻 */
async function clickAndHold(page: Page, tab: string): Promise<{ n: number; total: number; list: string[] }> {
  return page.evaluate(async (tab) => {
    type Held = {
      a: Animation;
      at: number;
      ct0: number;
      end: number;
      page: boolean;
    };
    const w = window as unknown as { __g7: Held[] };
    w.__g7 = [];
    const isPage = (a: Animation): boolean => {
      const pe = String((a.effect as KeyframeEffect | null)?.pseudoElement ?? '');
      const tg = (a.effect as KeyframeEffect | null)?.target;
      return (pe.startsWith('::view-transition') && !/\((tabbar|tabbar-add)\)$/.test(pe)) || (tg instanceof Element && tg.closest('main') !== null);
    };
    const seen = new Set<Animation>();
    const grabNew = (t0: number): number => {
      let k = 0;
      for (const a of document.getAnimations()) {
        if (seen.has(a)) continue;
        seen.add(a);
        const end = Number(a.effect?.getComputedTiming().endTime);
        if (!Number.isFinite(end)) continue; // 无限循环的（比如加载转圈）不归切页管
        a.pause();
        const ct0 = Number(a.currentTime ?? 0);
        w.__g7.push({
          a,
          at: performance.now() - t0 - ct0,
          ct0,
          end,
          page: isPage(a),
        });
        k += 1;
      }
      return k;
    };
    // 点之前已经在跑的不算（比如上一次的淡出尾巴）：先登记成见过
    for (const a of document.getAnimations()) seen.add(a);
    const t0 = performance.now();
    document.querySelector<HTMLElement>(`[data-testid="tabbar"] a[data-tab="${tab}"]`)?.click();
    let quiet = 0;
    while (performance.now() - t0 < 1500) {
      await new Promise((r) => requestAnimationFrame(r));
      const k = grabNew(t0);
      const page = w.__g7.some((h) => h.page);
      quiet = k === 0 ? quiet + 1 : 0;
      if (page && quiet >= 4) break;
    }
    const total = Math.max(0, ...w.__g7.map((h) => Math.max(0, h.at) + h.end));
    const list = w.__g7.map((h) => {
      const ef = h.a.effect as KeyframeEffect | null;
      const tg = ef?.target;
      const who = ef?.pseudoElement ?? (tg instanceof Element ? `${tg.tagName.toLowerCase()}.${String(tg.className).slice(0, 30)}` : '?');
      const t = ef?.getComputedTiming();
      return `${h.page ? '[页]' : ''}${who} at=${Math.round(h.at)} delay=${Math.round(Number(t?.delay ?? 0))} dur=${Math.round(Number(t?.duration ?? 0))} end=${Math.round(h.end)}`;
    });
    return { n: w.__g7.length, total, list };
  }, tab);
}

/**
 * 拨到页面过渡的 p（0～1）：时间轴是“页面那几段动画”（main 的淡入、View Transition 里页面的快照，底栏两组除外）从最早开始到最晚结束，
 * 别的动画（液滴、果冻）按同一个时刻对齐。p = 1 时放完全部动画，等 3 帧，把新起的动画停在开头。
 * 点按到页面动画开始之间（本机 webkit 上约 300 多 ms，换页渲染）DOM 已经换掉，事后拨不回去，这一段不在 0%～100% 里
 */
async function seek(page: Page, p: number): Promise<{ late: number; tMs: number }> {
  const res = await page.evaluate(async (p) => {
    type Held = {
      a: Animation;
      at: number;
      ct0: number;
      end: number;
      page: boolean;
    };
    const w = window as unknown as { __g7: Held[] };
    const pg = w.__g7.filter((h) => h.page);
    const base = pg.length > 0 ? pg : w.__g7;
    // 起点取“第一次看到它时”的时刻（at + ct0），不往前拨到没观察到的时刻：69659c1 的淡入一创建就跳过开头（motion 的 FADE_SKIP_MS），
    // 拨回 currentTime 0 会造出真机上没有的整页透明帧
    const t0 = Math.min(...base.map((h) => h.at + h.ct0));
    const t1 = Math.max(...base.map((h) => h.at + h.end));
    const t = t0 + p * (t1 - t0);
    if (p < 1) {
      for (const h of w.__g7) h.a.currentTime = Math.min(h.end, Math.max(h.ct0, t - h.at));
      return { late: 0, tMs: t };
    }
    for (const h of w.__g7) h.a.finish();
    const before = new Set(document.getAnimations());
    for (let i = 0; i < 3; i += 1) await new Promise((r) => requestAnimationFrame(r));
    let k = 0;
    for (const a of document.getAnimations()) {
      if (before.has(a)) continue;
      if (!Number.isFinite(Number(a.effect?.getComputedTiming().endTime))) continue;
      a.pause();
      a.currentTime = 0;
      k += 1;
    }
    return { late: k, tMs: t };
  }, p);
  await frames(page, 3);
  return res;
}

/** 这一帧有没有叠字：几个 main、各自不透明度；View Transition 里每组新旧快照的不透明度 */
async function overlapState(page: Page): Promise<{
  mains: number[];
  vt: Record<string, [number, number]>;
  overlap: boolean;
}> {
  return page.evaluate(() => {
    const op = (el: Element | null): number => {
      let o = 1;
      for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const mains = [...document.querySelectorAll('main')].map((m) => Math.round(op(m) * 100) / 100);
    const names = new Set<string>();
    for (const a of document.getAnimations()) {
      const m = /^::view-transition-(?:old|new)\((.+)\)$/.exec(String((a.effect as KeyframeEffect | null)?.pseudoElement ?? ''));
      if (m?.[1]) names.add(m[1]);
    }
    const vt: Record<string, [number, number]> = {};
    for (const n of names) {
      const o = Number(getComputedStyle(document.documentElement, `::view-transition-old(${n})`).opacity);
      const nw = Number(getComputedStyle(document.documentElement, `::view-transition-new(${n})`).opacity);
      vt[n] = [Math.round(o * 100) / 100, Math.round(nw * 100) / 100];
    }
    const overlap = mains.filter((o) => o > 0.05).length > 1 || Object.entries(vt).some(([n, [o, nw]]) => !n.startsWith('tabbar') && o > 0.05 && nw > 0.05);
    return { mains, vt, overlap };
  });
}

for (const [from, to, toTestid] of [
  ['today', 'todos', 'todos'],
  ['todos', 'today', 'today'],
] as const) {
  test.describe(`G7 切页逐帧 ${from} → ${to}`, () => {
    test.use({ loggedIn: true });

    test(`不叠字；底栏每一帧都是透明玻璃（0/20/40/60/100%）`, async ({ page }, ti) => {
      test.setTimeout(180_000); // 五帧，每帧整屏截图比对 + 4 张区域截图，3 倍屏 webkit 截一张就要一两秒
      await applyTheme(page, themeOf(ti));
      await freeze(page);
      await seedTodos(page, from);
      await settle(page, from);
      const barRaw = await rectOf(page, 'tabbar');
      const bar = pillCore(barRaw, 6);
      const ref: Rect = { x: 0, y: barRaw.y - 320, width: 440, height: 160 };
      // 内容区：顶部模糊带（安全区 62 + 12）以下，底部渐变带（底栏顶边往上 24 + 余量）以上
      const content: Rect = {
        x: 0,
        y: 100,
        width: 440,
        height: barRaw.y - 40 - 100,
      };
      const oldShot = await grab(page, content, 'css');
      await hideContent(page, true);
      const bg = await grab(page, content, 'css');
      await hideContent(page, false);
      const held = await clickAndHold(page, to);
      expect(held.n, '点了页签没有起任何动画').toBeGreaterThan(0);
      const out: Record<string, unknown>[] = [];
      const shots: { tag: string; f: Awaited<ReturnType<typeof grab>> }[] = [];
      for (const p of PCTS) {
        const { late, tMs } = await seek(page, p);
        const tag = `${String(Math.round(p * 100)).padStart(3, '0')}%`;
        // 切页帧的截图比对放宽：推帧的起点是“第一次看到页面动画”的时刻，每次差几毫秒，淡入的不透明度、液滴位置会差一点；
        // 判不符合原话靠下面的像素断言，截图比对只抓大的变化
        await expect(page).toHaveScreenshot(`G7-${from}到${to}-${tag}.png`, {
          maxDiffPixelRatio: 0.03,
        });
        const full = await page.screenshot({
          scale: 'device',
          animations: 'allow',
          caret: 'initial',
        });
        writeFileSync(ti.outputPath(`G7-${from}到${to}-${tag}.png`), full);
        const A = { bar: await grab(page, bar), ref: await grab(page, ref) };
        shots.push({ tag, f: await grab(page, content, 'css') });
        const st = await overlapState(page);
        await hideContent(page, true);
        const B = { bar: await grab(page, bar), ref: await grab(page, ref) };
        await hideContent(page, false);
        const dBar = Math.sqrt(meanVar(sub(A.bar.luma, B.bar.luma).d).variance);
        const dRef = Math.sqrt(meanVar(sub(A.ref.luma, B.ref.luma).d).variance);
        const judged = dRef >= G7_REF_MIN;
        const transmit = dRef === 0 ? 0 : dBar / dRef;
        out.push({
          p,
          tMs: Math.round(tMs),
          late,
          barDiffStd: r2(dBar),
          refDiffStd: r2(dRef),
          transmit: r2(transmit),
          judged,
          dom: st,
        });
        if (judged) expect.soft(transmit, `G7 ${tag}：底栏看着像实心（透过率 ${r2(transmit)}，底栏 D ${r2(dBar)} / 上方 D ${r2(dRef)}）`).toBeGreaterThanOrEqual(G7_MIN_TRANSMIT);
      }
      // 叠字：100% 那一帧当“新页”，点之前那一张当“旧页”
      const o = sub(oldShot.luma, bg.luma);
      const last = shots.at(-1);
      if (!last) throw new Error('没有帧');
      const n = sub(last.f.luma, bg.luma);
      shots.forEach(({ tag, f }, i) => {
        const { a, b } = mix(sub(f.luma, bg.luma), o, n);
        const row = out[i];
        if (row)
          Object.assign(row, {
            oldA: r2(a),
            newB: r2(b),
            overlap: a > G7_OVERLAP && b > G7_OVERLAP,
          });
        expect.soft(a > G7_OVERLAP && b > G7_OVERLAP, `G7 ${tag}：叠字（旧页还剩 ${r2(a)}、新页已有 ${r2(b)}）`).toBe(false);
      });
      await expect(page.locator(toTestid === 'today' ? '[data-testid="today"]' : '[data-testid="todos"]')).toBeVisible();
      const line = JSON.stringify({
        g: `G7-${from}到${to}`,
        project: ti.project.name,
        anims: held.list,
        totalMs: Math.round(held.total),
        frames: out,
      });
      process.stdout.write(`[visual] ${line}\n`);
      await ti.attach(`G7-${from}到${to}.json`, {
        body: line,
        contentType: 'application/json',
      });
      expect(out.filter((f) => f['judged']).length, '五帧里没有一帧上方有字，判不了底栏透不透').toBeGreaterThan(0);
    });
  });
}
