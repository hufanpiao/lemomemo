// 启动画面的收起（R-251；R-254 方向 B“在听”）。DOM 和样式在 src/index.html 的 #lemo-splash、src/styles/splash.css，
// 跟着网页第一次绘制出来，不等 React；这里只负责“App 好了就走”：加 .is-leaving 让整屏透明度 1→0
// （220 ms；减少动态效果 120 ms，时长写在 splash.css 里），淡完从 DOM 里移除。
// - 可以重复调用、并发调用：同一个启动画面只淡出一次，每次都拿到同一个 Promise；已经移除了（或页面里本来就没有）直接 resolve。
// - 不设最短显示时间（设计稿“出现和消失”）。
// - 不依赖 transitionend：后台标签页、jsdom 里可能不来，按时长 + 余量的定时器兜底移除。
// - splash.css 有 6 秒的纯 CSS 兜底（脚本没跑起来也不会一直盖着）：兜底淡完以后（visibility: hidden）再调，直接移除。
// - 减少动态效果的判断照 src/motion/reduced.ts 的两条（系统设置或 <html data-rm="1">）；platform 层不能引 motion，这里另写一份。
// 调用点：从启动起算 SPLASH_MAX_MS（5 秒）的兜底 hideSplashAfter；#root 里第一次画出东西的下一帧（main.tsx 经 root-paint.ts 的 whenContent），
// 这两处在 main.tsx 里都经 leaveSplash（非正式版先等诊断启动件 diag-boot.ts 打好多留标记）；
// 另挂在 body 下的“库被挡住”整屏提示提交后的下一帧（root.tsx 的 SplashRelease）、main.tsx 冷启动就进退出屏的两处：这三处直接收，不等诊断

export const SPLASH_ID = 'lemo-splash';
/** splash.css 里 .lemo-splash.is-leaving 的过渡时长（ms）：--dur-ui 220；减少动态效果 120（splash.css 里启动画面专用的那个令牌） */
export const SPLASH_FADE_MS = 220;
export const SPLASH_FADE_RM_MS = 120;
/** 最多盖多久：从启动起算 5 秒（和告知页关口的上限一样，R-250） */
export const SPLASH_MAX_MS = 5000;
/** 定时器兜底比过渡多等一点 */
const SLACK_MS = 80;
/** 启动画面颜色诊断（台账 Q-2，只在非正式版）在跑时：从第一次要收起的那一刻起再多留这么久，负责人来得及截图；正式构建整段摇掉 */
export const SPLASH_HOLD_MS = 8000;
/** 诊断启动件 diag-boot.ts 在涂色分包到了以后在 <html> 上设的标记（data-splash-hold；main.tsx 的 5 秒兜底和 #root 画出东西这两处先等 diag-boot，标记早于这两处的收起；进退出屏、库被挡住时直接收，不等诊断）；诊断撤掉时一起拿掉 */
export const SPLASH_HOLD_ATTR = 'splashHold';
let held: Promise<void> | null = null;

const leaving = new WeakMap<Element, Promise<void>>();

function reducedMotion(): boolean {
  if (document.documentElement.dataset['rm'] === '1') return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** splash.css 的 6 秒兜底已经把它淡掉了（visibility: hidden） */
function hiddenByCss(el: Element): boolean {
  return typeof getComputedStyle === 'function' && getComputedStyle(el).visibility === 'hidden';
}

/** 收起启动画面：淡出后移除 DOM。重复调用安全，返回同一个 Promise */
export function hideSplash(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const el = document.getElementById(SPLASH_ID);
  if (!el) return Promise.resolve();
  const running = leaving.get(el);
  if (running) return running;
  if (import.meta.env.MODE !== 'production' && document.documentElement.dataset[SPLASH_HOLD_ATTR] === '1') {
    held ??= new Promise<void>((resolve) => {
      setTimeout(() => {
        delete document.documentElement.dataset[SPLASH_HOLD_ATTR];
        held = null;
        resolve(hideSplash());
      }, SPLASH_HOLD_MS);
    });
    return held;
  }
  if (hiddenByCss(el)) {
    el.remove();
    return Promise.resolve();
  }

  const done = new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
      el.remove();
      resolve();
    };
    const onEnd = (e: Event) => {
      if (e.target === el && (e as TransitionEvent).propertyName === 'opacity') finish();
    };
    el.addEventListener('transitionend', onEnd);
    const timer = setTimeout(finish, (reducedMotion() ? SPLASH_FADE_RM_MS : SPLASH_FADE_MS) + SLACK_MS);
    el.classList.add('is-leaving');
  });
  leaving.set(el, done);
  return done;
}

/**
 * 启动画面还挡着界面吗：在页面里、没开始淡出、也没被 splash.css 的 6 秒兜底淡掉。
 * 淡出途中、兜底淡掉以后（DOM 还在，直到 hideSplash 移除）都算 false
 */
export function isSplashShowing(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(SPLASH_ID);
  return el !== null && !leaving.has(el) && !hiddenByCss(el);
}

/** 到点收起（从启动起算的兜底）：到点调 hide（main.tsx 传 leaveSplash，非正式版先等诊断启动件；别处直接传 hideSplash）；返回取消函数 */
export function hideSplashAfter(hide: () => unknown, ms: number = SPLASH_MAX_MS): () => void {
  const t = setTimeout(() => void hide(), ms);
  return () => clearTimeout(t);
}
