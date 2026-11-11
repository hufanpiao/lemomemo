// 冷启动高度校正的后两次触发（校正本身是 vh-gapfix-gate.ts 的 fixHeight）：iOS 主屏幕版冷启动时由 main.tsx 按需下载。
// ① 等早试结束、底栏挂上（今天页画好，最多 WAIT_BAR_MS）试一次；② 键盘真收了（viewport.ts 报）再试一次（收键盘后 iOS 会把布局视口还原成少一截的高度）。
// 同一时刻只做一次，做着时来的等做完再看；放垫块 SCROLL_AT_MS 还没回整屏补滚 1px、下一帧滚回（键盘那次手指按着或页面被滚过就不补，不抢用户的滚动）。
// 每一步记一行进 OUT_KEY（只留最近一次冷启动，诊断页显示、可复制）。requestAnimationFrame 只许 src/motion 用（A25），等帧的函数由调用方传
import { isStandalone } from './env.ts';
import { watchKeyboardClosed } from './viewport.ts';
import { earlyGap, fixHeight, gapState, insetTop, OFF_KEY, skipReason, type EarlyGap, type FixEnd, type Frame } from './vh-gapfix-gate.ts';

export const OUT_KEY = 'lemo-gapfix-out';
/** 放了垫块这么久还没回整屏：补一次滚动 */
export const SCROLL_AT_MS = 600;
/** 最多等这么久，到点撤掉垫块 */
export const GIVE_UP_MS = 1500;
/** 等底栏挂上（今天页画出来）最多这么久 */
export const WAIT_BAR_MS = 5000;
export const BAR_SELECTOR = '[data-testid="tabbar"]';
/** 日志最多留这么多行（第一行是开头，一直留着） */
export const MAX_LINES = 200;

/** 诊断页开关：默认开；关掉（存 OFF_KEY）用来对照。读不到本机存储时当开着（和 gapFixWanted 一致） */
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

export interface GapFixDeps {
  readonly win?: Window;
  readonly store?: Storage;
  readonly now?: () => number;
  readonly standalone?: boolean;
  /** 顶部安全区（测试用，可以每次读给不同的值；不传就读 --inset-top） */
  readonly top?: number | (() => number);
  /** 早试（测试用；不传就读这次冷启动的） */
  readonly early?: () => EarlyGap | null;
  /** 键盘真收了的通知（测试用；不传就是 viewport.ts 的 watchKeyboardClosed） */
  readonly kbClosed?: (fn: () => void) => () => void;
}

const TOUCH = ['touchstart', 'touchend', 'touchcancel'] as const;

/** 冷启动时调一次（main.tsx 动态加载本模块后调）。返回停止函数（测试用；到点自己也会停、撤掉垫块） */
export function startGapFix(frame: Frame, deps: GapFixDeps = {}): () => void {
  const win = deps.win ?? window;
  const doc = win.document;
  const standalone = deps.standalone ?? isStandalone();
  const store = deps.store ?? localStorage;
  const now = deps.now ?? (() => Date.now());
  const getEarly = deps.early ?? earlyGap;
  const readTop = (): number => (typeof deps.top === 'function' ? deps.top() : (deps.top ?? insetTop(doc)));
  const t0 = now();
  const lines = [`gapfix start=${new Date(t0).toISOString()} nav=${Math.round(win.performance.now())}ms screen=${win.screen.width}x${win.screen.height}`];
  const row = (what: string): void => {
    const bar = doc.querySelector(BAR_SELECTOR);
    lines.push(`t=${now() - t0} ${what} inner=${win.innerHeight} bar=${bar ? Math.round(bar.getBoundingClientRect().bottom) : '-'}`);
    if (lines.length > MAX_LINES) lines.splice(1, lines.length - MAX_LINES);
    try {
      store.setItem(OUT_KEY, lines.join('\n'));
    } catch {
      // 存不下：照样做
    }
  };
  let touching = false;
  const onTouch = (e: Event): void => {
    touching = e.type === 'touchstart';
  };
  let cancelled = false;
  /** 正在做（冷启动那次从等底栏就算）；做着时来的触发记在 again，做完再看 */
  let busy = true;
  let again: string | null = null;
  let stopRun = (): void => undefined;

  const idle = (): void => {
    busy = false;
    stopRun = () => undefined;
    if (again === null) return;
    const p = again;
    again = null;
    run(p);
  };
  /** 试一次；p 是日志前缀（冷启动 ''，键盘收起 'kb '） */
  const run = (p: string): void => {
    if (cancelled) return;
    if (!gapFixOn(store)) {
      row(`${p}skip off`);
      idle();
      return;
    }
    const s = gapState(win, standalone, readTop());
    const why = skipReason(s);
    if (why !== null) {
      row(`${p}skip ${why} top=${s.top}`);
      idle();
      return;
    }
    busy = true;
    const inner0 = win.innerHeight;
    const yPad = Math.round(win.scrollY);
    let scrolled = false;
    let finished = false;
    /** 自己滚之前的位置（没滚是 NaN）：还停在自己滚的那 1px 上才滚回，用户这时可能已经在滚（切到日历） */
    let y0 = Number.NaN;
    const backIfOurs = (): void => {
      if (Math.round(win.scrollY) === y0 + 1) win.scrollTo(0, y0);
    };
    const tick = (at: number): void => {
      if (scrolled || at < SCROLL_AT_MS) return;
      scrolled = true;
      const y = Math.round(win.scrollY);
      if (p !== '' && (touching || y !== yPad)) {
        row(`${p}scroll-skipped user-scrolling y=${y}`);
        return;
      }
      y0 = y;
      win.scrollBy(0, 1);
      row(`${p}scrollBy1 y=${Math.round(win.scrollY)}`);
      frame(() => {
        if (!finished) backIfOurs();
      });
    };
    const done = (how: FixEnd, h: number): void => {
      finished = true;
      if (scrolled) backIfOurs();
      const what = how === 'full' ? `changed ${inner0}->${h}${scrolled ? ' after-scroll' : ' by-pad'}` : how === 'stopped' ? 'stopped' : 'no-change';
      row(`${p}${what} pad-removed`);
      idle();
    };
    stopRun = fixHeight({ win, frame, now, giveUpMs: GIVE_UP_MS, tick, done }, s.full - s.inner);
    row(`${p}pad gap=${s.full - s.inner} top=${s.top} docH=${doc.documentElement.scrollHeight}`);
  };

  let earlyLogged = false;
  /** 等早试结束（不叠两块垫块）、等底栏挂上，再做冷启动那次 */
  const wait = (): void => {
    if (cancelled) return;
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
    run('');
  };
  // 网页版（不是主屏幕版）条件永远不满足，不盯键盘
  let stopKb = (): void => undefined;
  if (standalone) {
    for (const t of TOUCH) doc.addEventListener(t, onTouch, { passive: true });
    stopKb = (deps.kbClosed ?? watchKeyboardClosed)(() => {
      if (busy) again = 'kb ';
      else run('kb ');
    });
  }
  wait();
  return () => {
    cancelled = true;
    stopKb();
    for (const t of TOUCH) doc.removeEventListener(t, onTouch);
    stopRun();
  };
}
