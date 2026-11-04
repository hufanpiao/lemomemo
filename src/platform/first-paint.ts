// 首屏画完（B2 FA-6 ①）：冷启动时 supabase-js（约 53 KB gzip）和同步引擎要等第一个页面画出来以后再起，不和页面分包抢下载
// • “画完”= #root 里出现第一个功能页（main[data-feature]，告知页 onboarding 也算）以后再过一帧；
//   整屏提示（本机库来自更新的版本、被别的标签页挡住）没有 main[data-feature]，靠兜底：最多等 limitMs 就当画完了，同步不会因此一直不起
// • 兜底分两段（FA-6 推迟启动审查 L1）：时限从 render 之后才算（入口在 render 后调 startAppPaintLimit），冷启动本身慢（迁移、库被挡住）
//   不会把时限提前用完；挂上时另有一个长兜底 APP_PAINT_BACKSTOP_MS，入口在 render 之前就走了（换账号）时也不会一直不放行
// • 看到功能页以后不清兜底：后台标签页、托盘里启动时 rAF 不跑，那一帧永远不来，只能靠兜底放行（审查 L2）
// • 入口（src/app/main.tsx）在 render 之前调 watchAppPainted 挂上；afterAppPainted(fn) 在画完以后执行 fn。
//   没人挂过（登录页、测试、别的入口）时 afterAppPainted 当场执行，行为和以前一样
// • requestAnimationFrame 只许 src/motion 用（A25）：“再过一帧”由调用方传进来（motion 的 nextFrame）

export type FrameScheduler = (fn: () => void) => () => void;

/** 第一个功能页的选择器 */
export const APP_PAGE_SELECTOR = 'main[data-feature]';
/** 兜底：render 之后最多等这么久（毫秒）就当画完了（入口按告知页关口的时限另传，见 main.tsx） */
export const APP_PAINT_LIMIT_MS = 4000;
/** 长兜底：从挂上算，render 之前就走了、或冷启动特别慢时用 */
export const APP_PAINT_BACKSTOP_MS = 15_000;

let armed = false;
let done = false;
const waiters: (() => void)[] = [];
let limitTimer: ReturnType<typeof setTimeout> | null = null;

function finish(): void {
  if (done) return;
  done = true;
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
  for (const fn of waiters.splice(0)) {
    try {
      fn();
    } catch {
      // 一个回调出错不挡别的
    }
  }
}

/**
 * 盯住 root：第一个功能页出现后再过一帧算画完；backstopMs 长兜底（从挂上算）。只挂一次（重复调用不再挂）。返回取消函数（测试用）
 */
export function watchAppPainted(root: Element, nextFrame: FrameScheduler, backstopMs: number = APP_PAINT_BACKSTOP_MS): () => void {
  if (armed) return () => undefined;
  armed = true;
  let cancelFrame: (() => void) | null = null;
  const timer = setTimeout(finish, backstopMs);
  const seen = (): void => {
    if (cancelFrame) return;
    mo?.disconnect();
    cancelFrame = nextFrame(() => {
      clearTimeout(timer);
      finish();
    });
  };
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (root.querySelector(APP_PAGE_SELECTOR)) seen();
  }) : null;
  if (root.querySelector(APP_PAGE_SELECTOR)) seen();
  else mo?.observe(root, { childList: true, subtree: true });
  return () => {
    mo?.disconnect();
    clearTimeout(timer);
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
    cancelFrame?.();
  };
}

/** render 之后调一次：再等最多 limitMs 就当画完了。没挂过、已画完、已经开始计时的不再计 */
export function startAppPaintLimit(limitMs: number = APP_PAINT_LIMIT_MS): void {
  if (!armed || done || limitTimer !== null) return;
  limitTimer = setTimeout(finish, limitMs);
}

/** 首屏画完以后执行 fn；已经画完、或者没人挂过 watchAppPainted 时当场执行 */
export function afterAppPainted(fn: () => void): void {
  if (!armed || done) {
    fn();
    return;
  }
  waiters.push(fn);
}

/** 同上，Promise 写法（入口里 await 用） */
export function appPainted(): Promise<void> {
  return new Promise((ok) => afterAppPainted(ok));
}

/** 测试用 */
export function resetAppPaintedForTest(): void {
  armed = false;
  done = false;
  waiters.length = 0;
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
}
