// 冷启动高度校正（“布局视口少一截”只在这里治）：iOS 主屏幕版冷启动时布局视口少了顶部安全区，
// 放一个看不见的垫块让文档比视口高，iOS 会重算 innerHeight；回到整屏或到点就撤。本文件在首屏。
// 不变量：只在竖屏、少的正是顶部安全区时做；只做这一次，同一时刻最多一块垫块。requestAnimationFrame 只许 src/motion 用，等帧函数由调用方传
import { isAppleMobile, isStandalone, type NavLike } from './env.ts';
import { insetProbe } from './inset-watch.ts';
import { rlog } from './run-log-api.ts';
// 整屏几何从 viewport-screen.ts 引，不经 viewport-geom.ts：那份不在首屏块里
import { fullHeight, GAP_MAX_PX, isLandscape, TOL_PX } from './viewport-screen.ts';

export const PAD_ID = 'lemo-gapfix-pad';
/** 放了垫块这么久还没回到整屏就撤 */
export const GIVE_UP_MS = 1000;

export type Frame = (cb: () => void) => unknown;

/** 这次冷启动要不要做：iOS（iPhone、iPad）主屏幕版就做 */
export function gapFixWanted(nav: NavLike = navigator, media?: (q: string) => boolean): boolean {
  return isAppleMobile(nav) && isStandalone(nav, media);
}

/** 顶部安全区（px）：读 --inset-top，和页面用同一个值；探测块和 inset-watch.ts 共用 */
export function insetTop(doc: Document): number {
  const probe = insetProbe(doc, 'top');
  const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return px;
}

export interface GapState {
  readonly landscape: boolean;
  readonly inner: number;
  readonly full: number;
  /** 顶部安全区；冷启动时可能先读到 0 */
  readonly top: number;
}

/** null 是要做，否则是不做的原因。顶部安全区还读到 0 时只看差值够不够小 */
export function skipReason(s: GapState): string | null {
  if (s.landscape) return 'landscape';
  const gap = s.full - s.inner;
  if (gap <= 0) return `no-gap(${gap})`;
  if (s.top > 0 ? Math.abs(gap - s.top) > TOL_PX : gap > GAP_MAX_PX) return `gap-not-top(gap=${gap} top=${s.top})`;
  return null;
}

export interface GapFixDeps {
  readonly win?: Window;
  /** 默认 performance.now（系统时间往回调不影响） */
  readonly now?: () => number;
  readonly readTop?: () => number;
  readonly log?: (line: string) => void;
}

/**
 * main.tsx 在 gapFixWanted() 时同步调一次。放垫块后每帧看 innerHeight：回到整屏（差 TOL_PX 以内）就撤；GIVE_UP_MS 还没回到也撤。
 * 只认回到整屏：冷启动 innerHeight 会先抖 1px，一变就撤会把没修好的当成修好了
 */
export function startGapFix(frame: Frame, deps: GapFixDeps = {}): void {
  const win = deps.win ?? window;
  const doc = win.document;
  const now = deps.now ?? (() => win.performance.now());
  const log = deps.log ?? rlog;
  const s: GapState = { landscape: isLandscape(win), inner: win.innerHeight, full: fullHeight(win), top: (deps.readTop ?? (() => insetTop(doc)))() };
  const gap = s.full - s.inner;
  const at = Math.round(now());
  const tail = ` gap=${gap} top=${s.top}`;
  log(`gapfix start nav=${at}ms screen=${win.screen.width}x${win.screen.height} inner=${s.inner} full=${s.full}${s.landscape ? ' landscape' : ''}`);
  const why = skipReason(s);
  if (why !== null) {
    log(`gapfix early nav=${at}ms skip ${why}${tail}`);
    return;
  }
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
  (doc.body ?? doc.documentElement).append(pad);
  const t0 = now();
  const step = (): void => {
    const h = win.innerHeight;
    const fixed = fullHeight(win) - h <= TOL_PX;
    const after = Math.round(now() - t0);
    if (!fixed && after < GIVE_UP_MS) {
      frame(step);
      return;
    }
    pad.remove();
    log(`gapfix early nav=${at}ms ${fixed ? `changed ${s.inner}->${h}` : `no-change inner=${h}`} after=${after}ms${tail} gap-after=${fullHeight(win) - h}`);
  };
  frame(step);
}
