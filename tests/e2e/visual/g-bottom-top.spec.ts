// 视觉基准 G1～G5（docs/06-测试/负责人观感要求清单.md，负责人 11-06 原话）：底栏透明、底栏底边以下看不到字、渐变带、顶部模糊。
// 每条：toHaveScreenshot 截图比对（抓“变了”）+ 像素断言（抓“不符合原话”）。像素断言用 expect.soft，一条挂了别的照样量完、数值都打出来。
// 数值每条打一行 [visual] JSON（ci.yml 汇总步骤收集），也挂到报告附件里。阈值和定法写在常量旁边。
import { writeFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { backdropBlurWorks, bgLuma, edge, grab, inset, meanAbs, meanVar, pillCore, r2, type Rect, rectOf, rows, sub } from './pixels.ts';
import { applySimpleSkin, applyTheme, expect, freeze, hideBar, hideContent, scrollTo, scrollToCover, seedTodos, settle, solidBackdrop, still, test } from './visual-helpers.ts';

/**
 * G1 阈值：底栏（和“＋”）范围内 D = A − B 的标准差至少这么大，才算“后面的字透出来了”。
 * 定法：对照场景（两张都藏掉内容）的 D 标准差是噪声底，同一平台同一帧两次截图逐像素一样，实测 0；
 * 字在后面、底栏是实心时同样是 0（69659c1 实测）；字透过 3px 模糊、.12 着色的玻璃时远大于它（9d40848 实测见报告）。
 * 本机实测（440×956×3，浅/深 × 今天/待办）：69659c1（底栏后面实色）全是 0；9d40848（底栏透明）12.5～29.0。
 * 取 4：离两边都有余量，底栏一旦看着像实心就挂。
 */
export const G1_MIN_STD = 4;
/**
 * “＋”单独一档：它着的是黄色（--g-fab-tint，浅色 .72、深色 .86 不透明），后面的字本来只透出一两成。
 * 实测 69659c1 全是 0；9d40848（G8 定的样式基准）1.85～3.6。取 1.0
 */
export const G1_FAB_MIN_STD = 1.0;
/** G1 噪声底上限：对照场景的 D 标准差超过它，说明截图本身不稳，整条用例不可信，直接挂 */
export const NOISE_MAX_STD = 0.2;
/** G2：底栏底边以下逐行（横向）D 的标准差上限，“接近 0”；和噪声底同一量级（实测 69659c1 为 0，9d40848 为 30.9～59.0） */
export const G2_MAX_ROW_STD = 0.5;
/** G3：渐变带逐行亮度（归一化到 0～1）允许的回头量（抗锯齿、抖动），超过就是“不单调” */
export const G3_BACKTRACK = 0.02;
/** G3：一行（设备像素）里最多走总落差的多少：24px 线性渐变是 72 行、每行约 0.014；超过 0.12 就是看得见的台阶 */
export const G3_MAX_STEP = 0.12;
/**
 * G3（负责人 11-06 G12 选 B12“上沿外 12pt”，主持人 11-06 改定）：渐变从底栏上沿往上 12pt 处开始，越往下越接近底色，到红线成实色。
 * 原来的“底栏顶边处到底色比例 ≥ 0.98”是按 69659c1（实色铺到底栏后面）写的，和负责人要的“导航上边一点透明渐变看到字”相反，去掉；
 * 改成三条：① 上沿外 12pt 往下单调、没有台阶（G3_BACKTRACK、G3_MAX_STEP 照旧）；② 上沿外 12pt 以上不受影响；③ 红线处是底色
 */
export const G3_EDGE_PX = 12;
/** G3 ②：上沿外 G3_EDGE_PX 以上，到底色的比例上限（“不受影响”，和回头量同一量级） */
export const G3_ABOVE_MAX = 0.02;
/** G3 ③：红线（底栏、“＋”底边取低的那个）处到底色的比例下限 */
export const G3_AT_RED_MIN = 0.98;
/**
 * G3 ④：底栏上沿那一行到底色的比例下限，防退步（G12 B12 不许被去掉：上沿外 12pt 渐隐层没了，上沿处是 0，字在上沿被硬切）。
 * 本机实测 B12 为 0.47（3px 模糊、叠一半 --bg）；取 0.3（主持人 11-06 定）
 */
export const G3_AT_TOP_MIN = 0.3;
/** G4：渐变带高度上限（CSS px，负责人确认值 24px） */
export const G4_MAX_PX = 24;
/**
 * G5：顶部 0～40pt 的锐度（边缘强度 ÷ 反差）/ 屏幕中间同样内容的锐度，低于它才算“糊的、认不出”。
 * 暂定 0.5：本机 WebKit 不画 backdrop-filter，量不到真模糊的值（两版本机实测都是 0.94～1.06，即“没糊”）；
 * 第一次 CI（Linux）跑出数值后按实测改定，改的时候写明数值
 */
export const G5_MAX_SHARP_RATIO = 0.5;

type Theme = 'light' | 'dark';
const themeOf = (ti: TestInfo): Theme => (ti.project.use.colorScheme === 'dark' ? 'dark' : 'light');

function report(ti: TestInfo, name: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ g: name, project: ti.project.name, ...data });
  process.stdout.write(`[visual] ${line}\n`);
  void ti.attach(`${name}.json`, {
    body: line,
    contentType: 'application/json',
  });
}

function savePng(ti: TestInfo, name: string, png: Buffer): void {
  writeFileSync(ti.outputPath(`${name}.png`), png);
}

/** 底栏和“＋”两块：底栏去掉两端半圆、上下缩 6px；“＋”取内接正方形（圆半径 33，缩 10px）。避开圆角外直接露出的字、亮边、阴影 */
async function barRects(page: Page): Promise<{ bar: Rect; fab: Rect; barRaw: Rect }> {
  const barRaw = await rectOf(page, 'tabbar');
  const fabRaw = await rectOf(page, 'tabbar-add');
  return { bar: pillCore(barRaw, 6), fab: inset(fabRaw, 10), barRaw };
}

// 月历页（11-06 视觉验收：月格的农历在底栏里、日期数字在上沿）：G1、G2、G3（含 G12 上沿渐隐）同样量；默认是月视图
for (const [route, testid] of [
  ['today', 'today'],
  ['todos', 'todos'],
  ['calendar', 'cal'],
] as const) {
  test.describe(`${route} 页底部`, () => {
    test.use({ loggedIn: true });
    test.describe.configure({ timeout: 120_000 });

    test(`G1 底栏透明（后面的字透出来）＋ G2 底栏底边以下看不到字`, async ({ page }, ti) => {
      const theme = themeOf(ti);
      await applyTheme(page, theme);
      await applySimpleSkin(page);
      await freeze(page);
      await seedTodos(page, route);
      await settle(page, testid);
      const { bar, fab, barRaw } = await barRects(page);
      const barBottom = barRaw.y + barRaw.height;
      const below: Rect = {
        x: 0,
        y: barBottom,
        width: 440,
        height: 956 - barBottom,
      };
      const shot: Rect = {
        x: 0,
        y: barRaw.y - 30,
        width: 440,
        height: 956 - (barRaw.y - 30),
      };

      // G1：滚到字正好压在底栏后面的位置
      const s1 = await scrollToCover(page, bar.y, bar.y + bar.height);
      await still(page);
      await expect(page).toHaveScreenshot(`G1-底栏-有字在后面-${route}.png`, {
        clip: shot,
      });
      const A1 = {
        bar: await grab(page, bar),
        fab: await grab(page, fab),
        shot: await grab(page, shot),
      };
      await hideContent(page, true);
      const B1 = {
        bar: await grab(page, bar),
        fab: await grab(page, fab),
        shot: await grab(page, shot),
      };
      const B1b = { bar: await grab(page, bar) };
      await hideContent(page, false);
      savePng(ti, `G1-${route}-有字`, A1.shot.png);
      savePng(ti, `G1-${route}-对照无字`, B1.shot.png);

      // G2：滚到字正好压在底栏底边以下的位置
      const s2 = await scrollToCover(page, barBottom, 956);
      await still(page);
      await expect(page).toHaveScreenshot(`G2-底栏底边以下-${route}.png`, {
        clip: shot,
      });
      const A2 = {
        below: await grab(page, below),
        shot: await grab(page, shot),
      };
      await hideContent(page, true);
      const B2 = { below: await grab(page, below) };
      await hideContent(page, false);
      savePng(ti, `G2-${route}-有字`, A2.shot.png);

      const noise = Math.sqrt(meanVar(sub(B1.bar.luma, B1b.bar.luma).d).variance);
      const dBar = Math.sqrt(meanVar(sub(A1.bar.luma, B1.bar.luma).d).variance);
      const dFab = Math.sqrt(meanVar(sub(A1.fab.luma, B1.fab.luma).d).variance);
      const rawWith = meanVar(A1.bar.luma.d).variance;
      const rawWithout = meanVar(B1.bar.luma.d).variance;
      const dBelow = sub(A2.below.luma, B2.below.luma);
      const g2MaxRowStd = Math.max(0, ...rows(dBelow).map((r) => Math.sqrt(r.variance)));
      const g2MeanAbs = meanAbs(dBelow);
      report(ti, `G1G2-${route}`, {
        bar: barRaw,
        G1_scrollY: s1.scrollY,
        G1_textCover: r2(s1.cover),
        noiseStd: r2(noise),
        G1_barDiffStd: r2(dBar),
        G1_fabDiffStd: r2(dFab),
        G1_barRawVar_有字: r2(rawWith),
        G1_barRawVar_无字: r2(rawWithout),
        G2_scrollY: s2.scrollY,
        G2_textCover: r2(s2.cover),
        G2_belowHeightPx: r2(below.height),
        G2_maxRowDiffStd: r2(g2MaxRowStd),
        G2_meanAbsDiff: r2(g2MeanAbs),
      });

      expect(s1.cover, 'G1：找不到让字压在底栏后面的滚动位置（假数据不够长？）').toBeGreaterThan(0.3);
      expect(s2.cover, 'G2：找不到让字压在底栏底边以下的滚动位置').toBeGreaterThan(0.5);
      expect(noise, '对照场景两次截图不一样，像素断言不可信').toBeLessThanOrEqual(NOISE_MAX_STD);
      expect.soft(dBar, `G1：底栏后面的字没透出来（底栏看着像实心）D 标准差 ${r2(dBar)}`).toBeGreaterThan(G1_MIN_STD);
      expect.soft(dFab, `G1：“＋”后面的字没透出来 D 标准差 ${r2(dFab)}`).toBeGreaterThan(G1_FAB_MIN_STD);
      expect.soft(g2MaxRowStd, `G2：底栏底边以下看得到字（逐行 D 标准差最大 ${r2(g2MaxRowStd)}）`).toBeLessThanOrEqual(G2_MAX_ROW_STD);
    });

    test(`G3 渐变从上沿外 ${G3_EDGE_PX}pt 起逐行单调、没有台阶、到红线成底色 ＋ G4 高度不超过 ${G4_MAX_PX}px`, async ({ page }, ti) => {
      const theme = themeOf(ti);
      await applyTheme(page, theme);
      await applySimpleSkin(page);
      await freeze(page);
      await seedTodos(page, route);
      await settle(page, testid);
      const { barRaw } = await barRects(page);
      const fabRaw = await rectOf(page, 'tabbar-add');
      // 红线：底栏、“＋”的底边取低的那个（负责人 11-06 画的线）
      const redLine = Math.max(barRaw.y + barRaw.height, fabRaw.y + fabRaw.height);
      // 底栏后面铺一整屏和底色反差最大的纯色，藏掉底栏和“＋”，只看带子自己从“内容”过渡到底色的那一段
      await hideContent(page, true);
      await hideBar(page, true);
      await solidBackdrop(page, theme === 'dark' ? '#FFFFFF' : '#000000');
      await still(page);
      const strip: Rect = { x: 0, y: barRaw.y - 100, width: 440, height: 100 };
      await expect(page).toHaveScreenshot(`G3-渐变带-${route}.png`, {
        clip: {
          x: 0,
          y: barRaw.y - 100,
          width: 440,
          height: 956 - (barRaw.y - 100),
        },
      });
      const g = await grab(page, strip);
      savePng(ti, `G3-${route}-渐变带`, g.png);
      // 上沿以下整行会穿过底栏、“＋”的形状（那里本来就是玻璃，藏掉以后露出挖空），G3 ①③ 改看两条竖条：
      // 屏幕左边（底栏左边以外）和底栏、“＋”之间的窄缝（G12：这两处不许有硬边），从带子上方一直量到红线以下 2pt
      const colTop = barRaw.y - 100;
      const cols: Record<string, Rect> = {
        左边: { x: 2, y: colTop, width: Math.max(2, barRaw.x - 4), height: redLine + 2 - colTop },
        窄缝: { x: barRaw.x + barRaw.width + 2, y: colTop, width: Math.max(2, fabRaw.x - (barRaw.x + barRaw.width) - 4), height: redLine + 2 - colTop },
      };
      const gc: Record<string, Awaited<ReturnType<typeof grab>>> = {};
      for (const [k, r] of Object.entries(cols)) gc[k] = await grab(page, r);
      // 归一化：0 = 纯色内容（最上面一行，带子上方），1 = 皮肤底色 --bg（带子该变成的实色）
      const lc = rows(g.luma)[0]?.mean ?? 0;
      const lbg = await bgLuma(page);
      await solidBackdrop(page, null);
      await hideBar(page, false);
      await hideContent(page, false);

      const span = lbg - lc;
      const t = rows(g.luma).map((r) => (span === 0 ? 0 : (r.mean - lc) / span));
      let backtrack = 0;
      let maxStep = 0;
      for (let i = 1; i < t.length; i += 1) {
        const dt = (t[i] ?? 0) - (t[i - 1] ?? 0);
        backtrack = Math.max(backtrack, -dt);
        maxStep = Math.max(maxStep, Math.abs(dt));
      }
      const inBand = t.filter((v) => v > 0.02 && v < 0.98).length / 3; // 设备像素 → CSS px
      const atBarTop = t.at(-1) ?? 0; // 底栏顶边那一行到了底色的多少（G3 ④，B12 在这里是叠一半底色）
      // ② 上沿外 12pt 以上（整行）：不受影响
      const aboveRows = Math.max(0, Math.floor((barRaw.y - G3_EDGE_PX - strip.y) * 3));
      const aboveMax = Math.max(0, ...t.slice(0, aboveRows).map(Math.abs));
      // ①③ 两条竖条：逐行单调、没有台阶，红线那一行到了底色
      const colStat: Record<string, { backtrack: number; maxStep: number; atRed: number; above: number }> = {};
      for (const [k, gk] of Object.entries(gc)) {
        const tc = rows(gk.luma).map((r) => (span === 0 ? 0 : (r.mean - lc) / span));
        let bt = 0;
        let ms = 0;
        for (let i = 1; i < tc.length; i += 1) {
          const dt = (tc[i] ?? 0) - (tc[i - 1] ?? 0);
          bt = Math.max(bt, -dt);
          ms = Math.max(ms, Math.abs(dt));
        }
        const redRow = Math.round((redLine - colTop) * 3);
        colStat[k] = {
          backtrack: bt,
          maxStep: ms,
          atRed: Math.min(...tc.slice(redRow)),
          above: Math.max(0, ...tc.slice(0, Math.floor((barRaw.y - G3_EDGE_PX - colTop) * 3)).map(Math.abs)),
        };
      }
      report(ti, `G3G4-${route}`, {
        contentLuma: r2(lc),
        bgLuma: r2(lbg),
        G3_backtrack: r2(backtrack),
        G3_maxStepPerRow: r2(maxStep),
        G4_bandHeightPx: r2(inBand),
        G3_atBarTop: r2(atBarTop),
        G3_aboveEdgeMax: r2(aboveMax),
        redLine,
        G3_cols: Object.fromEntries(Object.entries(colStat).map(([k, v]) => [k, { backtrack: r2(v.backtrack), maxStep: r2(v.maxStep), atRed: r2(v.atRed), above: r2(v.above) }])),
        profile: t.filter((_, i) => i % 6 === 0).map(r2),
      });
      expect(Math.abs(span), '纯色内容和底色几乎一样，量不出渐变').toBeGreaterThan(60);
      expect.soft(backtrack, `G3：渐变带亮度不单调（回头 ${r2(backtrack)}）`).toBeLessThanOrEqual(G3_BACKTRACK);
      expect.soft(maxStep, `G3：渐变带有台阶（一行走了 ${r2(maxStep)}）`).toBeLessThanOrEqual(G3_MAX_STEP);
      expect.soft(atBarTop, `G3：底栏上沿处没有渐隐（到底色只有 ${r2(atBarTop)}，B12 上沿外 ${G3_EDGE_PX}pt 渐隐层没了？）`).toBeGreaterThanOrEqual(G3_AT_TOP_MIN);
      expect.soft(aboveMax, `G3：底栏上沿外 ${G3_EDGE_PX}pt 以上也被盖了（到底色 ${r2(aboveMax)}）`).toBeLessThanOrEqual(G3_ABOVE_MAX);
      for (const [k, v] of Object.entries(colStat)) {
        expect.soft(v.above, `G3：${k}在上沿外 ${G3_EDGE_PX}pt 以上也被盖了（到底色 ${r2(v.above)}）`).toBeLessThanOrEqual(G3_ABOVE_MAX);
        expect.soft(v.backtrack, `G3：${k}从上沿外到红线亮度不单调（回头 ${r2(v.backtrack)}）`).toBeLessThanOrEqual(G3_BACKTRACK);
        expect.soft(v.maxStep, `G3：${k}从上沿外到红线有台阶（一行走了 ${r2(v.maxStep)}）`).toBeLessThanOrEqual(G3_MAX_STEP);
        expect.soft(v.atRed, `G3：${k}到红线还没变成底色（只到 ${r2(v.atRed)}）`).toBeGreaterThanOrEqual(G3_AT_RED_MIN);
      }
      expect.soft(inBand, `G4：渐变带 ${r2(inBand)}px，超过 ${G4_MAX_PX}px`).toBeLessThanOrEqual(G4_MAX_PX + 1);
    });
  });
}

test.describe('顶部', () => {
  test.use({ loggedIn: true });
  test.describe.configure({ timeout: 120_000 });

  test('G5 滚动后顶部 0～40pt 的字是糊的', async ({ page, browser }, ti) => {
    // 本机 Windows WebKit 不画 backdrop-filter（探针实测），“糊不糊”在那里量不出来，跳过并注明；CI（Linux）上探针不过直接挂，不许悄悄跳过
    const blurOk = await backdropBlurWorks(browser);
    if (process.env['CI'] === 'true') expect(blurOk, 'CI 的 WebKit 不画 backdrop-filter，G5 判不了').toBe(true);
    test.skip(!blurOk, '这个 WebKit 不画 backdrop-filter 的模糊（本机 Windows 实测），G5 只在 Linux（CI）判');
    const theme = themeOf(ti);
    await applyTheme(page, theme);
    await applySimpleSkin(page);
    await freeze(page);
    await seedTodos(page, 'todos');
    await settle(page, 'todos');
    await scrollTo(page, 300);
    await still(page);
    const top: Rect = { x: 0, y: 0, width: 440, height: 40 };
    const mid: Rect = { x: 0, y: 420, width: 440, height: 40 };
    await expect(page).toHaveScreenshot('G5-顶部-滚动后.png', {
      clip: { x: 0, y: 0, width: 440, height: 120 },
    });
    const A = { top: await grab(page, top), mid: await grab(page, mid) };
    savePng(ti, 'G5-顶部-滚动后', (await grab(page, { x: 0, y: 0, width: 440, height: 120 })).png);
    await hideContent(page, true);
    const B = { top: await grab(page, top), mid: await grab(page, mid) };
    await hideContent(page, false);
    const dTop = sub(A.top.luma, B.top.luma);
    const dMid = sub(A.mid.luma, B.mid.luma);
    // 锐度 = 边缘强度 ÷ 反差（标准差）：字只是变淡（盖了一层半透明）时两者同比例变小，锐度不变，照样认得出；
    // 真被模糊了，边缘变缓、锐度才掉下去。只比边缘强度会把“变淡但清楚”误判成“糊了”（69659c1 本机实测：顶部的字淡了、清清楚楚，边缘强度只有中间的 0.16）
    const sTop = Math.sqrt(meanVar(dTop.d).variance);
    const sMid = Math.sqrt(meanVar(dMid.d).variance);
    const eTop = edge(dTop);
    const eMid = edge(dMid);
    const sharpTop = sTop === 0 ? 0 : eTop / sTop;
    const sharpMid = sMid === 0 ? 0 : eMid / sMid;
    const ratio = sharpMid === 0 ? 1 : sharpTop / sharpMid;
    report(ti, 'G5', {
      edgeTop: r2(eTop),
      edgeMid: r2(eMid),
      stdTop: r2(sTop),
      stdMid: r2(sMid),
      sharpTop: r2(sharpTop),
      sharpMid: r2(sharpMid),
      sharpRatio: r2(ratio),
    });
    expect(sMid, '屏幕中间没有字，没法对照').toBeGreaterThan(3);
    expect(sTop, '顶部 0～40pt 后面没有内容，量不出糊不糊').toBeGreaterThan(0.5);
    expect.soft(ratio, `G5：顶部的字还清楚可读（锐度是中间同样内容的 ${r2(ratio)} 倍，要 ≤ ${G5_MAX_SHARP_RATIO}）`).toBeLessThanOrEqual(G5_MAX_SHARP_RATIO);
  });
});
