// 冷启动高度校正（这类事只在这里做）：iOS 主屏幕版布局视口少了顶部安全区（895 / 956）时，fixHeight 放一个看不见的垫块让文档比视口高，
// iOS 这时会重算 innerHeight；到点照样撤。触发：main.tsx 一开始同步试一次（startEarlyGapFix，启动画面还盖着，只认回到整屏），
// 等底栏挂上、键盘真收起由按需下载的 vh-gapfix.ts 再调 fixHeight（innerHeight 一变就撤）。本文件在首屏（main.tsx 静态引），只放这几样。
// 不变量：只在竖屏、少的正是顶部安全区时做；同一时刻最多一块垫块。requestAnimationFrame 只许 src/motion 用（A25），等帧的函数由调用方传
import { isAppleMobile, isStandalone, type NavLike } from './env.ts';
import { insetProbe } from './inset-watch.ts';
// 整屏几何从 viewport-screen.ts 引，不经 viewport-geom.ts：那份不在首屏块里，跟着 viewport.ts 的分包按需下载（11-12 首屏瘦身）
import { fullHeight, GAP_MAX_PX, isLandscape, TOL_PX } from './viewport-screen.ts';

/** 诊断页“关掉用来对照”存的键：存了 '1' 就不做 */
export const OFF_KEY = 'lemo-gapfix-off';
export const PAD_ID = 'lemo-gapfix-pad';
/** 早试放了垫块这么久还没回到整屏就撤，交给等底栏后那一次 */
export const EARLY_GIVE_UP_MS = 1000;

export type Frame = (cb: () => void) => unknown;

/** 这次冷启动要不要做：iOS（iPhone、iPad）、主屏幕版、诊断页没关掉。读不到本机存储时照默认做 */
export function gapFixWanted(nav: NavLike = navigator, media?: (q: string) => boolean, store?: Storage): boolean {
  if (!isAppleMobile(nav) || !isStandalone(nav, media)) return false;
  try {
    return (store ?? localStorage).getItem(OFF_KEY) !== '1';
  } catch {
    return true;
  }
}

/** 顶部安全区（px）：读 --inset-top（base.css，= env(safe-area-inset-top)），和页面用的是同一个值；探测块和 inset-watch.ts 读底部安全区的是同一个 */
export function insetTop(doc: Document): number {
  const probe = insetProbe(doc, 'top');
  const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return px;
}

export interface GapState {
  readonly standalone: boolean;
  readonly landscape: boolean;
  /** innerHeight */
  readonly inner: number;
  /** 整屏高（viewport-screen 的 fullHeight） */
  readonly full: number;
  /** 顶部安全区；冷启动时可能先读到 0 */
  readonly top: number;
}

export const gapState = (win: Window, standalone: boolean, top: number): GapState => ({ standalone, landscape: isLandscape(win), inner: win.innerHeight, full: fullHeight(win), top });

/** 做不做：null 是要做，否则是不做的原因（写进日志）。顶部安全区还读到 0 时只看差值够不够小 */
export function skipReason(s: GapState): string | null {
  if (!s.standalone) return 'not-standalone';
  if (s.landscape) return 'landscape';
  const gap = s.full - s.inner;
  if (gap <= 0) return `no-gap(${gap})`;
  if (s.top > 0 ? Math.abs(gap - s.top) > TOL_PX : gap > GAP_MAX_PX) return `gap-not-top(gap=${gap} top=${s.top})`;
  return null;
}

/** 怎么结束的：innerHeight 到了结束条件（见 FixRun.anyChange）、到点没到、调用方停了 */
export type FixEnd = 'changed' | 'gave-up' | 'stopped';

export interface FixRun {
  readonly win: Window;
  readonly frame: Frame;
  readonly now: () => number;
  /** 放了垫块这么久还没到结束条件就撤 */
  readonly giveUpMs: number;
  /**
   * true：innerHeight 一变就撤（等底栏后、收键盘后两次，和改前 padFix 一样：这时用户能点“＋”，弹键盘把 innerHeight 压矮的那一帧就得撤）；
   * 不传：只认回到整屏（早试：冷启动 innerHeight 会先抖 1px 894→895，一变就撤会把没修好的当成修好了，台账 Q-2；这时启动画面盖着，没有输入框）
   */
  readonly anyChange?: boolean;
  /** 还没到结束条件、没到点时每帧调一次（参数：放垫块后过了多少 ms） */
  readonly tick?: (at: number) => void;
  /** 撤了垫块以后调：怎么结束的、那时的 innerHeight、用了多少 ms */
  readonly done: (how: FixEnd, inner: number, at: number) => void;
}

/** 校正一次：放垫块（绝对定位、1px 宽、看不见、不接点按，文档高 = 一屏 + 差值 + 1px），每帧看 innerHeight 到了结束条件没有。返回停止函数 */
export function fixHeight(r: FixRun, gap: number): () => void {
  const { win, frame, now } = r;
  const doc = win.document;
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
  const inner0 = win.innerHeight;
  (doc.body ?? doc.documentElement).append(pad);
  const t0 = now();
  let over = false;
  const end = (how: FixEnd): void => {
    if (over) return;
    over = true;
    pad.remove();
    r.done(how, win.innerHeight, Math.round(now() - t0));
  };
  const step = (): void => {
    if (over) return;
    const h = win.innerHeight;
    if (r.anyChange ? h !== inner0 : fullHeight(win) - h <= TOL_PX) {
      end('changed');
      return;
    }
    const at = now() - t0;
    if (at >= r.giveUpMs) {
      end('gave-up');
      return;
    }
    r.tick?.(at);
    frame(step);
  };
  frame(step);
  return () => end('stopped');
}

/** 早试的结果：at 是开始时刻（页面打开起算 ms），done 以前 vh-gapfix.ts 不开始，what 是写进日志的结果 */
export interface EarlyGap {
  readonly at: number;
  done: boolean;
  what: string;
}

let early: EarlyGap | null = null;
/** 这次冷启动的早试（没试过是 null） */
export const earlyGap = (): EarlyGap | null => early;

/** main.tsx 在 gapFixWanted() 时同步调一次（不等底栏、不补滚动）；后三个参数测试用 */
export function startEarlyGapFix(
  frame: Frame,
  win: Window = window,
  now: () => number = () => win.performance.now(),
  readTop: () => number = () => insetTop(win.document),
): EarlyGap {
  const s = gapState(win, true, readTop());
  const tail = ` gap=${s.full - s.inner} top=${s.top}`;
  const e: EarlyGap = { at: Math.round(now()), done: false, what: '' };
  early = e;
  const why = skipReason(s);
  if (why !== null) {
    e.done = true;
    e.what = `skip ${why}${tail}`;
    return e;
  }
  const done = (how: FixEnd, h: number, after: number): void => {
    e.done = true;
    e.what = `${how === 'changed' ? `changed ${s.inner}->${h}` : `no-change inner=${h}`} after=${after}ms${tail}`;
  };
  fixHeight({ win, frame, now, giveUpMs: EARLY_GIVE_UP_MS, done }, s.full - s.inner);
  return e;
}
