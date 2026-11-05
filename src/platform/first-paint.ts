// 首屏画完（B2 FA-6 ①）：冷启动时 supabase-js（约 53 KB gzip）和同步引擎要等第一个页面画出来以后再起，不和页面分包抢下载
// • “画完”= #root 里出现第一个页面（任何 <main>，告知页 onboarding 也算）以后再过一帧；
//   整屏提示（本机库来自更新的版本、被别的标签页挡住）没有 <main>，靠兜底：最多等 limitMs 就当画完了，同步不会因此一直不起
// • 选择器为什么是 'main' 而不是 'main[data-feature]'（FIRSTPAINT-nofeature，提醒挂载统一审查 F1，11-04 放宽）：
//   有些页面的根是不带 data-feature 的 <main>，冷启动落在这些页时要等 render 后约 6 秒的兜底，同步、supabase-js 跟着晚起。
//   现在靠不带 data-feature 的 <main> 触发的：kit 的 EditShell（编辑页）、reminders 的 FullReminderPage（整页提醒，
//   从系统通知点进来最常见的冷启动路径）、开发版的 CspLab；其余页面（含 App.tsx 的出错页、功能关闭页）的根都是 main[data-feature]。
// • 约束：App 外壳（App.tsx、root.tsx、关口、横幅、Suspense 占位等页面以外的部分）不许放常驻的 <main>，
//   否则页面分包还没到就“画完”了，同步会和页面分包抢下载。src/app/__tests__/first-paint-shell.test.tsx 渲染 App 拦这一条；
//   不带 data-feature 的 <main> 只许出现在登记过的页面里（first-paint-pages.test.tsx 扫源码，新增要先登记）
// • 兜底分两段（FA-6 推迟启动审查 L1）：时限从 render 之后才算（入口在 render 后调 startAppPaintLimit），冷启动本身慢（迁移、库被挡住）
//   不会把时限提前用完；挂上时另有一个长兜底 APP_PAINT_BACKSTOP_MS，入口在 render 之前就走了（换账号）时也不会一直不放行
// • 看到功能页以后不清兜底：后台标签页、托盘里启动时 rAF 不跑，那一帧永远不来，只能靠兜底放行（审查 L2）
// • 入口（src/app/main.tsx）在 render 之前调 watchAppPainted 挂上；afterAppPainted(fn) 在画完以后执行 fn。
//   没人挂过（登录页、测试、别的入口）时 afterAppPainted 当场执行，行为和以前一样
// • requestAnimationFrame 只许 src/motion 用（A25）：“再过一帧”由调用方传进来（motion 的 nextFrame）

export type FrameScheduler = (fn: () => void) => () => void;

/** 第一个页面的选择器（为什么不再要求 data-feature 见文件头） */
export const APP_PAGE_SELECTOR = 'main';
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
