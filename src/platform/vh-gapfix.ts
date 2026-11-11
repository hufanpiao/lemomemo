// 底栏偏高修复（R-371 Gap fix，11-10 主持人批；11-11 负责人真机通过后改成默认开，正式版也做）：
// 只在 iOS 主屏幕版冷启动时由 main.tsx 动态加载（判断在 vh-gapfix-gate.ts）；诊断页“Gap fix”开关改成“关掉用来对照”（存 OFF_KEY）。
// 现象（负责人原话“就刚打开的时候底栏在上面，只要切换到日历或者代办他就落下去了”）：iPhone 主屏幕版冷启动后 innerHeight 比屏幕少一个顶部安全区
// （895 / 956，差 61），今天页底栏跟着可见区底边偏高；第一次切到日历、待办就恢复，切设置不恢复。
// 推断：日历（6 行月格，和数据无关）、负责人的待办长列表在 895 高时文档比视口高、页面能滚；今天页（body min-height: 100dvh，正好一屏）、设置不超过一屏。
// iOS 在文档变得比视口高时重算了可见高度。这里照日历的样子做一次：
//   ① 条件（都满足才做，不然记 skip 什么都不动）：主屏幕版、竖屏、screen.height − innerHeight 落在顶部安全区（--inset-top）± TOL_PX 以内、而且大于 0；
//   ② 在 body 里放一个看不见的垫块（绝对定位、1px 宽、visibility hidden、不接点按），文档高度 = 一屏 + 差值 + 1px，页面变得能滚；不挪底栏、不改任何看得见的东西；
//   ③ 每帧看 innerHeight 变没变；放垫块后 SCROLL_AT_MS 还没变再补一次“滚 1px、下一帧滚回”；变了或放垫块后到 GIVE_UP_MS 就撤掉垫块（从放垫块算起，等底栏、重读顶部安全区的时间不算）。
// 台账 Q-2（11-11）：main.tsx 一开始先同步早试一次（vh-gapfix-gate.ts 的 startEarlyGapFix），本模块等早试结束、把结果记一行，再照原样做（早试成了，这里就是 skip no-gap）。
// 等底栏挂上（今天页画好，最多 WAIT_BAR_MS）再判断、再做。冷启动时顶部安全区可能先读到 0（底部就有过“先 0 后 34”）：
// 读到 0 而别的条件都满足时，每 TOP_RETRY_FRAMES 帧重读一次，最多 TOP_RETRY_MS，重读的结果记进日志（代码审建议 1）。
// 滚 1px 只在下一帧滚回一次；撤垫块时只在页面还停在那 1px 上才滚回，用户已经自己在滚（比如切到日历）就不动（代码审 M1）。
// 每一步记一行（时刻、inner、底栏下沿），存在 OUT_KEY（只留最近一次冷启动），诊断页显示、可复制。没关掉时每次冷启动都做（不像时间线只跑一次）。
// 正常启动（inner = 屏幕高）条件不满足，什么都不做，像素不变；底栏、“＋”、实色带（R-361“这个不要动”）都不碰。
// 键盘收起后再做一次（Q-4，11-11）：主屏幕版时 vh-gapfix-kb.ts 盯键盘起落，键盘真收了再按同一套①②③做一次，日志行带 kb 前缀；
//   键盘那次用户手指按着或页面已经被滚过，就不补那 1px 滚动（代码审 M1）。日志最多留 MAX_LINES 行。
// requestAnimationFrame 只许 src/motion 用（A25）：等帧的函数由调用方传进来（main.tsx 传 motion 的 nextFrame）
import { isStandalone } from './env.ts';
import { earlyGap, insetTop, OFF_KEY, PAD_ID, TOL_PX, type EarlyGap } from './vh-gapfix-gate.ts';
import { watchKbClose, type KbWatch } from './vh-gapfix-kb.ts';

export { insetTop, PAD_ID, TOL_PX };

export const OUT_KEY = 'lemo-gapfix-out';
/** 放了垫块这么久 innerHeight 还没变：补一次滚动 */
export const SCROLL_AT_MS = 600;
/** 最多等这么久，到点撤掉垫块 */
export const GIVE_UP_MS = 1500;
/** 等底栏挂上（今天页画出来）最多这么久，和“切到日历”时一样是在页面画好以后做 */
export const WAIT_BAR_MS = 5000;
/** 顶部安全区读到 0 时最多重读这么久 */
export const TOP_RETRY_MS = 1000;
/** 顶部安全区读到 0 时隔几帧重读 */
export const TOP_RETRY_FRAMES = 4;
export const BAR_SELECTOR = '[data-testid="tabbar"]';
/** 日志最多留这么多行（第一行是开头，一直留着） */
export const MAX_LINES = 200;

export type Frame = (cb: () => void) => unknown;

/** 诊断页开关：默认开；关掉（存 OFF_KEY）用来对照。读不到本机存储时当开着（和 vh-gapfix-gate.ts 一致） */
export function gapFixOn(store: Storage = localStorage): boolean {
  try {
    return store.getItem(OFF_KEY) !== '1';
  } catch {
    return true;
  }
}

export function setGapFixOn(on: boolean, store: Storage = localStorage): void {
  try {
    if (on) store.removeItem(OFF_KEY);
    else store.setItem(OFF_KEY, '1');
  } catch {
    // 本机存储用不了：关不掉，诊断页照样显示 ON
  }
}

export function readGapFixLog(store: Storage = localStorage): string {
  try {
    return store.getItem(OUT_KEY) ?? '';
  } catch {
    return '';
  }
}

export interface GapState {
  readonly standalone: boolean;
  readonly inner: number;
  readonly width: number;
  readonly screenH: number;
  readonly top: number;
}

/** 要不要做：返回 null 是要做，否则是不做的原因（写进日志） */
export function skipReason(s: GapState): string | null {
  if (!s.standalone) return 'not-standalone';
  if (s.width >= s.inner) return 'landscape';
  const gap = s.screenH - s.inner;
  if (gap <= 0) return `no-gap(${gap})`;
  if (Math.abs(gap - s.top) > TOL_PX) return `gap-not-top(gap=${gap} top=${s.top})`;
  return null;
}

export interface GapFixDeps {
  readonly win?: Window;
  readonly store?: Storage;
  readonly now?: () => number;
  readonly standalone?: boolean;
  /** 顶部安全区（测试用，可以每次读给不同的值；不传就读 --inset-top） */
  readonly top?: number | (() => number);
  /** 早试（vh-gapfix-gate.ts 的 startEarlyGapFix；测试用，不传就读这次冷启动的） */
  readonly early?: () => EarlyGap | null;
}

const barBottom = (doc: Document): string => {
  const el = doc.querySelector(BAR_SELECTOR);
  return el ? String(Math.round(el.getBoundingClientRect().bottom)) : '-';
};

interface PadCtx {
  readonly win: Window;
  readonly frame: Frame;
  readonly now: () => number;
  readonly row: (what: string) => void;
  /** 手指按着屏幕（键盘那次用：用户在滚就不补滚动） */
  readonly touching: () => boolean;
}

/** ②③：放垫块、必要时滚 1px、撤垫块，撤完调 onEnd。p 是日志前缀（冷启动 ''，键盘收起 'kb '）；键盘那次用户在滚就不补滚动。返回停止函数 */
function padFix(c: PadCtx, state: GapState, p: string, onEnd: () => void): () => void {
  const { win, frame, now, row } = c;
  const doc = win.document;
  const inner0 = win.innerHeight;
  const gap = state.screenH - inner0;
  const pad = doc.createElement('div');
  pad.id = PAD_ID;
  pad.setAttribute('aria-hidden', 'true');
  for (const [k, v] of [
    ['position', 'absolute'],
    ['top', '0'],
    ['left', '0'],
    ['width', '1px'],
    ['height', `calc(100dvh + ${gap + 1}px)`],
    ['visibility', 'hidden'],
    ['pointer-events', 'none'],
  ] as const)
    pad.style.setProperty(k, v);
  let done = false;
  let scrolled = false;
  let y0 = 0;
  let tPad = 0;
  let yPad = 0;
  /** 还停在自己滚的那 1px 上才滚回：用户这时可能已经在滚（切到日历），不能拉回去 */
  const backIfOurs = (): void => {
    if (Math.round(win.scrollY) === y0 + 1) win.scrollTo(0, y0);
  };
  const finish = (what: string): void => {
    if (done) return;
    done = true;
    pad.remove();
    if (scrolled) backIfOurs();
    row(`${p}${what} pad-removed`);
    onEnd();
  };
  const step = (): void => {
    if (done) return;
    if (win.innerHeight !== inner0) {
      finish(`changed ${inner0}->${win.innerHeight}${scrolled ? ' after-scroll' : ' by-pad'}`);
      return;
    }
    const at = now() - tPad;
    if (at >= GIVE_UP_MS) {
      finish('no-change');
      return;
    }
    if (!scrolled && at >= SCROLL_AT_MS) {
      scrolled = true;
      const y = Math.round(win.scrollY);
      if (p !== '' && (c.touching() || y !== yPad)) {
        // 代码审 M1：用户正在滚，不抢滚动位置；只靠垫块，到点照样撤（scrolled 记 true 但不滚，撤时也不滚回）
        y0 = Number.NaN;
        row(`${p}scroll-skipped user-scrolling y=${y}`);
        frame(step);
        return;
      }
      y0 = y;
      win.scrollBy(0, 1);
      row(`${p}scrollBy1 y=${Math.round(win.scrollY)}`);
      frame(() => {
        if (!done) backIfOurs();
        frame(step);
      });
      return;
    }
    frame(step);
  };
  (doc.body ?? doc.documentElement).append(pad);
  tPad = now();
  yPad = Math.round(win.scrollY);
  row(`${p}pad gap=${gap} top=${state.top} docH=${doc.documentElement.scrollHeight}`);
  frame(step);
  return () => finish('stopped');
}

/** 冷启动时调一次（main.tsx 在 iOS 主屏幕版、没关掉时动态加载本模块后调）；主屏幕版时同时盯键盘收起（Q-4，vh-gapfix-kb.ts）。返回停止函数（测试用；到点自己也会停、撤掉垫块） */
export function startGapFix(frame: Frame, deps: GapFixDeps = {}): () => void {
  const win = deps.win ?? window;
  const standalone = deps.standalone ?? isStandalone();
  const store = deps.store ?? localStorage;
  const now = deps.now ?? (() => Date.now());
  const doc = win.document;
  const t0 = now();
  const getEarly = deps.early ?? earlyGap;
  const lines: string[] = [`gapfix start=${new Date(t0).toISOString()} nav=${Math.round(win.performance.now())}ms screen=${win.screen.width}x${win.screen.height}`];
  const row = (what: string): void => {
    lines.push(`t=${now() - t0} ${what} inner=${win.innerHeight} bar=${barBottom(doc)}`);
    if (lines.length > MAX_LINES) lines.splice(1, lines.length - MAX_LINES);
    try {
      store.setItem(OUT_KEY, lines.join('\n'));
    } catch {
      // 存不下：照样做
    }
  };
  /** 最近一次读到的顶部安全区（判断键盘在不在时用，不每次重读） */
  let lastTop = 0;
  const readTop = (): number => {
    lastTop = typeof deps.top === 'function' ? deps.top() : (deps.top ?? insetTop(doc));
    return lastTop;
  };
  const stateNow = (): GapState => ({ standalone, inner: win.innerHeight, width: win.innerWidth, screenH: win.screen.height, top: readTop() });
  let topTries = 0;
  let topT0 = -1;
  let cancelled = false;
  /** 正在做（冷启动那次从等底栏就算）：键盘那边不叠着做 */
  let busy = true;
  let kb: KbWatch | null = null;
  let stopFix = (): void => undefined;
  const later = (n: number, cb: () => void): void => {
    frame(() => {
      if (cancelled) return;
      if (n <= 1) cb();
      else later(n - 1, cb);
    });
  };
  const idle = (): void => {
    busy = false;
    stopFix = () => undefined;
    kb?.idle();
  };
  const ctx: PadCtx = { win, frame, now, row, touching: () => kb?.touching() ?? false };
  const fix = (state: GapState, p: string): void => {
    busy = true;
    stopFix = padFix(ctx, state, p, idle);
  };
  const run = (): void => {
    const state = stateNow();
    const why = skipReason(state);
    if (why !== null && state.top === 0 && why.startsWith('gap-not-top')) {
      // 顶部安全区还没出来（先 0 后 61）：隔几帧重读，不当成“差值不是顶部安全区”直接放过
      if (topT0 < 0) {
        topT0 = now();
        row(`top=0 reread every ${TOP_RETRY_FRAMES} frames`);
      }
      if (now() - topT0 < TOP_RETRY_MS) {
        topTries += 1;
        later(TOP_RETRY_FRAMES, run);
        return;
      }
    }
    if (topTries > 0) row(`top-reread tries=${topTries} after=${now() - topT0}ms top=${state.top}${state.top === 0 ? ' still-0' : ''}`);
    if (why !== null) {
      row(`skip ${why} top=${state.top}`);
      idle();
      return;
    }
    fix(state, '');
  };
  let earlyLogged = false;
  const wait = (): void => {
    if (cancelled) return;
    // 早试还在等 innerHeight 变：等它结束（最多 EARLY_GIVE_UP_MS），不叠两块垫块；结束了先把早试结果记一行
    const e = getEarly();
    if (e !== null && !e.done) {
      frame(wait);
      return;
    }
    if (e !== null && !earlyLogged) {
      earlyLogged = true;
      row(`early nav=${e.at}ms ${e.what}`);
    }
    if (doc.querySelector(BAR_SELECTOR) === null && now() - t0 < WAIT_BAR_MS) {
      frame(wait);
      return;
    }
    run();
  };
  /** 键盘真收了（Q-4）：诊断页没关掉、条件①照样满足才按同一套再做，日志带 kb */
  const kbFix = (): void => {
    if (!gapFixOn(store)) {
      row('kb skip off');
      return;
    }
    const state = stateNow();
    const why = skipReason(state);
    if (why !== null) {
      row(`kb skip ${why} top=${state.top}`);
      return;
    }
    fix(state, 'kb ');
  };
  // 网页版（不是主屏幕版）条件①永远不满足，不盯键盘
  if (standalone) kb = watchKbClose({ win, frame, now, row, busy: () => busy, top: () => lastTop, tryFix: kbFix });

  wait();
  return () => {
    cancelled = true;
    kb?.stop();
    stopFix();
  };
}
