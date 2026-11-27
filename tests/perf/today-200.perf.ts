// 今天页 200 行测量（第三方审查分诊表“前端-15”）：每行各挂错误边界（QuietBoundary）、Suspense（kit Later）和订阅（未同步小标记等），行多了慢不慢。
// 只量、不断言快慢：判断标准（滚动 60fps 下掉帧超过 5%、勾一条重画超过 50ms 算慢）写在交回报告里，数据打到输出（PERF_OUT 给路径时另存 JSON）。
// 做法：本机时区挑此刻是上午的那个（today-seed.ts），往本机库 planner-v4 写 100 条今天下午的日程（12:05 起每 5 分钟一条、不进“已过去”）
// 和 100 条今天截止的待办（不带时刻），手机宽度 430×932、DPR 3；先重新载入一次等 SW 接管，再重新载入 3 次，每次量三样：
// ① 首次画出：导航开始 → 200 行都进了 DOM 之后的下一帧（rAF 后 setTimeout 0）；另记 FCP 和载入后 3 秒内的长任务（首屏画完才挂的 Later 也在里面）
// ② 滚动掉帧：按 1500px/s 从顶滚到底再滚回顶（见 measureScroll），期间 rAF 记每帧间隔；掉帧 = Σ(round(间隔/16.67) − 1)，占比 = 掉帧 / 应有帧数
// ③ 勾一条待办：真鼠标点方框；Event Timing（PerformanceObserver 'event'，含处理和画出来那一下）取这次点击里最长的一条；
//    另记从 click 算起到 change 处理完后下一帧的自测时间（fromClick，判断用这个：不含 Playwright 发按下、松开之间的进程间空档）、从 pointerdown 算起的，和之后 1.5 秒（留在原位 → 收起 → 归进“已过去”那几次重画）里最长的一帧（long-animation-frame）
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../e2e/session-fixture.ts';
import { PERF_USE, seedToday, tdId, TZ, warmSw } from './today-seed.ts';

/** PERF_ROWS：总行数（日程、待办各一半），默认 200；PERF_DPR：设备像素比，默认 3（对照用） */
const N_EV = Number(process.env['PERF_ROWS'] ?? '200') / 2;
const N_TD = N_EV;
const RUNS = 3;
const CPU = Number(process.env['PERF_CPU'] ?? '1');
const DPR = Number(process.env['PERF_DPR'] ?? '3');

test.use({ ...PERF_USE, deviceScaleFactor: DPR });

/** 每次导航都先装上：200 行进 DOM 的时刻、FCP、长任务、长动画帧、Event Timing、rAF 记帧开关 */
const INIT = `(() => {
  const P = (window.__perf = { rowsDom: null, rows: null, long: [], loaf: [], events: [], frames: null, tap: null, audio: [] });
  // 放音上下文的同步耗时（main f5e104f5 起首屏画完 300ms 先建好，手势里只 resume）：包一层构造和 resume，记 [new|resume, 时刻, 毫秒]
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const W = function (...a) {
      const t = performance.now();
      const c = new AC(...a);
      P.audio.push(['new', t, performance.now() - t]);
      const resume = c.resume.bind(c);
      c.resume = () => { const t2 = performance.now(); const r = resume(); P.audio.push(['resume', t2, performance.now() - t2]); return r; };
      return c;
    };
    W.prototype = AC.prototype;
    window.AudioContext = W;
    if (window.webkitAudioContext) window.webkitAudioContext = W;
  }
  const want = Number(sessionStorage.getItem('perfWant') || ${N_EV + N_TD});
  const count = () => document.querySelectorAll('[data-testid^="today-event-"],[data-testid^="today-row-"]').length;
  const mo = new MutationObserver(() => {
    if (P.rowsDom !== null || count() < want) return;
    P.rowsDom = performance.now();
    mo.disconnect();
    requestAnimationFrame(() => setTimeout(() => { P.rows = performance.now(); }, 0));
  });
  mo.observe(document, { childList: true, subtree: true });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.loaf.push([e.startTime, e.duration, e.blockingDuration || 0, { render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0, styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, scripts: (e.scripts || []).map((x) => [x.invoker, Math.round(x.duration), x.sourceFunctionName || '', (x.sourceURL || '').split('/').pop()]).slice(0, 5) }]); }).observe({ type: 'long-animation-frame', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.events.push([e.name, e.startTime, e.duration, e.processingStart - e.startTime, e.processingEnd - e.processingStart, e.interactionId || 0]); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
  // 自测的勾选重画：pointerdown 的 timeStamp → change 处理完（window 冒泡阶段，React 已提交）以后的下一帧
  addEventListener('pointerdown', (e) => { if (P.tap && P.tap.t0 === null) P.tap.t0 = e.timeStamp; }, true);
  addEventListener('click', (e) => { if (P.tap && P.tap.t1 === null) P.tap.t1 = e.timeStamp; }, true);
  addEventListener('change', () => {
    if (!P.tap || P.tap.t0 === null || P.tap.done !== null) return;
    P.tap.handled = performance.now();
    requestAnimationFrame(() => setTimeout(() => { P.tap.done = performance.now(); }, 0));
  });
})();`;

interface Run {
  fcp: number;
  rowsDom: number;
  rows: number;
  loadLongSum: number;
  loadLongMax: number;
  scroll: { fetched: string[]; sw: boolean; worstLoaf: unknown; frames: number; height: number; expected: number; dropped: number; ratio: number; medianDt: number; maxDt: number; loafMax: number };
  tap: { eventMax: number; self: number; fromClick: number; clickEvent: number; handled: number; flowLoafMax: number; flowLongMax: number; worstEvent: unknown; worstLoaf: unknown; audio: string[]; fetched: string[] }[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

/** want：这次应在 DOM 里的行数（前几次勾掉的待办已收进“已过去”、折叠着不画） */
async function measureLoad(page: Page, want: number): Promise<Pick<Run, 'fcp' | 'rowsDom' | 'rows' | 'loadLongSum' | 'loadLongMax'>> {
  await page.evaluate((n) => sessionStorage.setItem('perfWant', String(n)), want);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __perf: { rows: number | null } }).__perf.rows !== null, undefined, { timeout: 60_000 });
  // 首屏画完才挂、才下载的几包（子任务卡片、未同步小标记、左滑）也算进载入：等 3 秒让它们挂完
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const P = (window as unknown as { __perf: { rowsDom: number; rows: number; long: [number, number][] } }).__perf;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? Number.NaN;
    const ds = P.long.map(([, d]) => d);
    return { fcp, rowsDom: P.rowsDom, rows: P.rows, loadLongSum: ds.reduce((a, b) => a + b, 0), loadLongMax: Math.max(0, ...ds) };
  });
}

/**
 * 滚动：每一帧（rAF）按经过的时间把滚动容器挪到 1500px/s 该在的位置，到底以后再同样滚回顶，期间记每帧的时间戳。
 * 不用 CDP Input.synthesizeScrollGesture：无头 Chromium 里鼠标滚轮手势第二段一直不返回（11-21 实测卡满 5 分钟）。
 * 每帧改 scrollTop 要主线程配合，量到的正是行多了以后主线程能不能每帧都跟上（排版、绘制、React 有没有跟着滚动重画）
 */
async function measureScroll(page: Page): Promise<Run['scroll']> {
  const [startLoaf, startAt] = await page.evaluate(() => [(window as unknown as { __perf: { loaf: unknown[] } }).__perf.loaf.length, performance.now()]);
  const res = await page.evaluate(
    () =>
      new Promise<{ frames: number[]; height: number }>((resolve) => {
        const main = document.querySelector('[data-testid="today"]');
        let el: Element | null = main;
        while (el && !(el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        const sc = (el ?? document.scrollingElement ?? document.documentElement) as HTMLElement;
        sc.scrollTop = 0;
        const max = sc.scrollHeight - sc.clientHeight;
        const frames: number[] = [];
        const SPEED = 1.5; // px/ms，约 1500px/s；按时间算位置，帧掉了位置照样往前走（同真滚动），不会因为帧慢拖长
        const tag = `${sc.tagName}.${sc.className}`;
        let t0 = -1;
        let stuck = 0;
        const tick = (t: number) => {
          if (t0 < 0) t0 = t;
          frames.push(t);
          const d = (t - t0) * SPEED;
          const pos = d <= max ? d : Math.max(0, 2 * max - d);
          const before = sc.scrollTop;
          sc.scrollTop = pos;
          // 滚不动（滚动位置连着 30 帧没变）就此收手，报出是哪个元素，不卡满用例超时
          stuck = sc.scrollTop === before && pos > 0 ? stuck + 1 : 0;
          if (stuck > 30) return resolve({ frames, height: -1, tag, top: sc.scrollTop, max } as never);
          if (d >= 2 * max) return resolve({ frames, height: max });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  return page.evaluate(
    ({ startLoaf, startAt, f, height }) => {
      const w = window as unknown as { __perf: { loaf: [number, number, number, unknown][] } };
      const FRAME = 1000 / 60;
      let expected = 0;
      let dropped = 0;
      const dts: number[] = [];
      for (let i = 1; i < f.length; i++) {
        const dt = (f[i] ?? 0) - (f[i - 1] ?? 0);
        dts.push(dt);
        const slots = Math.max(1, Math.round(dt / FRAME));
        expected += slots;
        dropped += slots - 1;
      }
      const s = [...dts].sort((a, b) => a - b);
      const loafs = w.__perf.loaf.slice(startLoaf);
      const loaf = loafs.map(([, d]) => d);
      const worst = loafs.reduce<(typeof loafs)[number] | null>((a, b) => (!a || b[1] > a[1] ? b : a), null);
      const fetched = performance.getEntriesByType('resource').filter((e) => e.startTime >= startAt).map((e) => `${e.name.split('/').pop()}:${Math.round(e.duration)}`);
      return { fetched, sw: !!navigator.serviceWorker?.controller, worstLoaf: worst ? { at: worst[0], d: worst[1], ...(worst[3] as object) } : null, frames: f.length, height, expected, dropped, ratio: expected ? dropped / expected : 0, medianDt: s[Math.floor(s.length / 2)] ?? 0, maxDt: s[s.length - 1] ?? 0, loafMax: Math.max(0, ...loaf) };
    },
    { startLoaf, startAt, f: res.frames, height: res.height },
  ).then((r) => {
    if (r.height < 0) throw new Error(`滚不动：${JSON.stringify({ ...res, frames: res.frames.length })}`);
    return r;
  });
}

async function measureTap(page: Page, id: string): Promise<Run['tap'][number]> {
  const box = page.getByTestId(`today-done-${id}`);
  await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const mark = await page.evaluate(() => {
    const P = (window as unknown as { __perf: { tap: unknown; events: unknown[]; loaf: unknown[]; long: unknown[] } }).__perf;
    P.tap = { t0: null, t1: null, handled: null, done: null };
    return { ev: P.events.length, loaf: P.loaf.length, long: P.long.length, at: performance.now() };
  });
  await box.click();
  await expect(box).toBeChecked();
  // 留在原位约 720 ms → 收起 → 归进“已过去”：1.5 秒里的几次重画都等完
  await page.waitForTimeout(1500);
  return page.evaluate((mark) => {
    const P = (window as unknown as {
      __perf: { audio: [string, number, number][]; tap: { t0: number; t1: number; handled: number; done: number }; events: [string, number, number, number, number, number][]; loaf: [number, number, number, unknown][]; long: [number, number][] };
    }).__perf;
    const evs = P.events.slice(mark.ev).filter(([n]) => ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'change', 'input'].includes(n));
    return {
      eventMax: Math.max(0, ...evs.map(([, , d]) => d)),
      self: P.tap.done - P.tap.t0,
      // 从 click 开始算（不含 Playwright 发 pointerdown、pointerup 之间那段进程间的空档）：click → change 处理、React 提交 → 下一帧
      fromClick: P.tap.done - P.tap.t1,
      clickEvent: Math.max(0, ...evs.filter(([n]) => n === 'click').map(([, , d]) => d)),
      handled: P.tap.handled - P.tap.t0,
      flowLoafMax: Math.max(0, ...P.loaf.slice(mark.loaf).map(([, d]) => d)),
      flowLongMax: Math.max(0, ...P.long.slice(mark.long).map(([, d]) => d)),
      // 诊断：最长那条事件的拆分（输入等待、处理、处理完到画出）、最长那一帧的拆分、这次点击以后新下载的文件
      worstEvent: evs.reduce<(typeof evs)[number] | null>((a, b) => (!a || b[2] > a[2] ? b : a), null),
      worstLoaf: P.loaf.slice(mark.loaf).reduce<(typeof P.loaf)[number] | null>((a, b) => (!a || b[1] > a[1] ? b : a), null),
      // 这一下里放音上下文花的同步时间（建、resume），和是不是这一下才建的
      audio: P.audio.filter(([, t]) => t >= mark.at).map(([k, , d]) => `${k}:${Math.round(d)}`),
      fetched: performance.getEntriesByType('resource').filter((e) => e.startTime >= mark.at).map((e) => `${e.name.split('/').pop()}:${Math.round(e.duration)}`),
    };
  }, mark);
}

test('今天页 200 行：首次画出、滚动掉帧、勾一条的重画', async ({ page }) => {
  await page.addInitScript(INIT);
  await page.goto('/app/#/today');
  await page.getByTestId('today').waitFor({ timeout: 30_000 });
  await seedToday(page, N_EV, N_TD);
  await warmSw(page);
  const cdp = await page.context().newCDPSession(page);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

  const runs: Run[] = [];
  for (let k = 0; k < RUNS; k++) {
    // 第 k 次重新载入时，前 k 次各勾掉的 3 条已收进“已过去”（折叠着、不画），其余都在“今天的安排”里
    const load = await measureLoad(page, N_EV + N_TD - 3 * k);
    await expect(page.locator('[data-testid^="today-event-"]')).toHaveCount(N_EV);
    await expect(page.locator('[data-testid^="today-row-"]')).toHaveCount(N_TD - 3 * k);
    const scroll = await measureScroll(page);
    // 每次勾不同的三条（重新载入后前面勾掉的已进“已过去”，不重复）；第 k 次勾第 3k+0、+1、+2 条
    const tap: Run['tap'] = [];
    for (let j = 0; j < 3; j++) tap.push(await measureTap(page, tdId(k * 3 + j)));
    runs.push({ ...load, scroll, tap });
  }

  const taps = runs.flatMap((r) => r.tap);
  const summary = {
    cpu: CPU,
    dpr: DPR,
    tz: TZ,
    rows: N_EV + N_TD,
    firstPaint: {
      rowsPaintedMs: r1(median(runs.map((r) => r.rows))),
      rowsInDomMs: r1(median(runs.map((r) => r.rowsDom))),
      fcpMs: r1(median(runs.map((r) => r.fcp))),
      loadLongTaskSumMs: r1(median(runs.map((r) => r.loadLongSum))),
      loadLongTaskMaxMs: r1(median(runs.map((r) => r.loadLongMax))),
    },
    scroll: {
      droppedRatioPct: r1(median(runs.map((r) => r.scroll.ratio * 100))),
      dropped: median(runs.map((r) => r.scroll.dropped)),
      expected: median(runs.map((r) => r.scroll.expected)),
      medianFrameMs: r1(median(runs.map((r) => r.scroll.medianDt))),
      scrollHeightPx: median(runs.map((r) => r.scroll.height)),
      maxFrameMs: r1(median(runs.map((r) => r.scroll.maxDt))),
      loafMaxMs: r1(median(runs.map((r) => r.scroll.loafMax))),
    },
    tap: {
      // 每次重新载入勾 3 条，先取每次的中位数，再取 3 次的中位数
      eventTimingMs: r1(median(runs.map((r) => median(r.tap.map((x) => x.eventMax))))),
      selfMs: r1(median(runs.map((r) => median(r.tap.map((x) => x.self))))),
      fromClickMs: r1(median(runs.map((r) => median(r.tap.map((x) => x.fromClick))))),
      clickEventMs: r1(median(runs.map((r) => median(r.tap.map((x) => x.clickEvent))))),
      handledMs: r1(median(runs.map((r) => median(r.tap.map((x) => x.handled))))),
      flowLoafMaxMs: r1(median(runs.map((r) => median(r.tap.map((x) => x.flowLoafMax))))),
      flowLongMaxMs: r1(median(runs.map((r) => median(r.tap.map((x) => x.flowLongMax))))),
      all: taps.map((x) => ({ ev: r1(x.eventMax), click: r1(x.fromClick), self: r1(x.self), loaf: r1(x.flowLoafMax), audio: x.audio.join(' ') })),
      // 每次打开后的第一下（单独看：首屏后第一次勾选），其余几下的中位数
      firstClickMs: r1(median(runs.map((r) => r.tap[0]?.fromClick ?? Number.NaN))),
      restClickMs: r1(median(runs.flatMap((r) => r.tap.slice(1).map((x) => x.fromClick)))),
    },
  };
  console.log(`PERF ${JSON.stringify(summary)}`);
  const out = process.env['PERF_OUT'];
  if (out) writeFileSync(out, JSON.stringify({ summary, runs }, null, 2));
});
