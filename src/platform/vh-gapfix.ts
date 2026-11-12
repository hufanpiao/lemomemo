// 冷启动高度校正的后两次触发（校正本身是 vh-gapfix-gate.ts 的 fixHeight）：iPhone 主屏幕版冷启动时由 main.tsx 按需下载。
// ① 等早试结束、底栏挂上（今天页画好，最多 WAIT_BAR_MS）试一次；② 键盘真收了（viewport.ts 报）再试一次（收键盘后 iOS 会把布局视口还原成少一截的高度）。
// 放垫块后 innerHeight 一变就撤（这两次用户能点“＋”，弹键盘压矮的那一帧就撤）；SCROLL_AT_MS 还没变补滚 1px、下一帧滚回。
// 不变量：输入框聚焦着（键盘要弹、正弹、iOS 在定光标）不放新垫块、不补滚（台账 Q-8、Q-24 那两个真机问题都在这段时间）；
// 键盘那次手指按着或页面被滚过也不补滚。同一时刻只做一次：做着时来的“键盘收了”这次不接，viewport.ts 保持上膛，下一次视口事件静下来再报。
// 顶部安全区读到 0（冷启动先 0 后 61）：冷启动那次隔帧重读，一直 0 就不做；收键盘那次不重读、直接不做。
// 每一步经 run-log-api.ts 的 rlog 记一行 gapfix …（进全局运行日志，诊断页“Copy run log”一起复制；正式构建 rlog 是空的）。requestAnimationFrame 只许 src/motion 用（A25），等帧的函数由调用方传
import { isStandalone, opensKeyboard } from './env.ts';
import { BAR_SELECTOR, rlog } from './run-log-api.ts';
import { watchKeyboardClosed } from './viewport.ts';
import { earlyGap, fixHeight, gapState, insetTop, OFF_KEY, skipReason, type EarlyGap, type FixEnd, type Frame } from './vh-gapfix-gate.ts';

/** 放了垫块这么久 innerHeight 还没变：补一次滚动 */
export const SCROLL_AT_MS = 600;
/** 最多等这么久，到点撤掉垫块 */
export const GIVE_UP_MS = 1500;
/** 顶部安全区读到 0 时最多重读这么久（冷启动那次） */
export const TOP_RETRY_MS = 1000;
/** 顶部安全区读到 0 时隔几帧重读 */
export const TOP_RETRY_FRAMES = 4;
/** 等底栏挂上（今天页画出来）最多这么久 */
export const WAIT_BAR_MS = 5000;

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

export interface GapFixDeps {
  readonly win?: Window;
  readonly store?: Storage;
  readonly now?: () => number;
  readonly standalone?: boolean;
  /** 顶部安全区（测试用，可以每次读给不同的值；不传就读 --inset-top） */
  readonly top?: number | (() => number);
  /** 早试（测试用；不传就读这次冷启动的） */
  readonly early?: () => EarlyGap | null;
  /** 键盘真收了的通知（测试用；不传就是 viewport.ts 的 watchKeyboardClosed）。fn 返回 false 是这次没接（正在做） */
  readonly kbClosed?: (fn: () => boolean) => () => void;
  /** 记一行（测试用；不传就是 rlog） */
  readonly log?: (line: string) => void;
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
  const log = deps.log ?? rlog;
  const t0 = now();
  log(`gapfix start nav=${Math.round(win.performance.now())}ms screen=${win.screen.width}x${win.screen.height}`);
  const row = (what: string): void => {
    const bar = doc.querySelector(BAR_SELECTOR);
    log(`gapfix +${now() - t0}ms ${what} inner=${win.innerHeight} bar=${bar ? Math.round(bar.getBoundingClientRect().bottom) : '-'}`);
  };
  let touching = false;
  const onTouch = (e: Event): void => {
    touching = e.type === 'touchstart';
  };
  let cancelled = false;
  /** 正在做（冷启动那次从等底栏就算）：这时来的“键盘收了”不接 */
  let busy = true;
  let stopRun = (): void => undefined;
  const idle = (): void => {
    busy = false;
    stopRun = () => undefined;
  };
  /** 隔 n 帧再做冷启动那次（停了的话 run 开头就回） */
  const later = (n: number): unknown => frame(() => (n <= 1 ? run('') : later(n - 1)));
  let topT0 = -1;
  let topTries = 0;
  /** 冷启动那次顶部安全区读到 0：重读期内隔 TOP_RETRY_FRAMES 帧再试、返回 true；过了期返回 false */
  const reread = (): boolean => {
    if (topT0 < 0) {
      topT0 = now();
      row(`top=0 reread every ${TOP_RETRY_FRAMES} frames`);
    }
    if (now() - topT0 >= TOP_RETRY_MS) return false;
    topTries += 1;
    later(TOP_RETRY_FRAMES);
    return true;
  };
  /** 试一次；p 是日志前缀（冷启动 ''，键盘收起 'kb '） */
  const run = (p: string): void => {
    if (cancelled) return;
    if (!gapFixOn(store)) {
      row(`${p}skip off`);
      idle();
      return;
    }
    // 输入框聚焦着不放垫块（返修单之外加的，主持人 11-11 接受：方向保守）。冷启动那次碰上聚焦就整次放弃、不再重试，
    // 等收键盘那次（键盘真收了、离开输入框静下来）补
    if (opensKeyboard(doc.activeElement)) {
      row(`${p}skip editing`);
      idle();
      return;
    }
    const s = gapState(win, standalone, readTop());
    let why = skipReason(s);
    // skipReason 在顶部安全区读到 0 时只看差值（早试用）；这两次要等读出真值才做（改前做法，代码审建议 1）
    if (why === null && s.top === 0) {
      if (p === '' && reread()) return;
      why = `gap-not-top(gap=${s.full - s.inner} top=0)`;
    }
    if (p === '' && topTries > 0) {
      row(`top-reread tries=${topTries} after=${now() - topT0}ms top=${s.top}${s.top === 0 ? ' still-0' : ''}`);
      topTries = 0;
    }
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
      if (opensKeyboard(doc.activeElement)) {
        row(`${p}scroll-skipped editing y=${y}`);
        return;
      }
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
      const what = how === 'changed' ? `changed ${inner0}->${h}${scrolled ? ' after-scroll' : ' by-pad'}` : how === 'stopped' ? 'stopped' : 'no-change';
      row(`${p}${what} pad-removed`);
      idle();
    };
    stopRun = fixHeight({ win, frame, now, giveUpMs: GIVE_UP_MS, anyChange: true, tick, done }, s.full - s.inner);
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
      if (busy) {
        row('kb skip busy');
        return false;
      }
      run('kb ');
      return true;
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
