// 启动画面的收起（R-251；R-254 方向 B“在听”）。DOM 和样式在 src/index.html 的 #lemo-splash、src/styles/splash.css，
// 跟着网页第一次绘制出来，不等 React；这里只负责“App 好了就走”：加 .is-leaving 让整屏透明度 1→0
// （220 ms；减少动态效果 120 ms，时长写在 splash.css 里），淡完从 DOM 里移除。
// - 可以重复调用、并发调用：同一个启动画面只淡出一次，每次都拿到同一个 Promise；已经移除了（或页面里本来就没有）直接 resolve。
// - 不设最短显示时间（设计稿“出现和消失”）。
// - 不依赖 transitionend：后台标签页、jsdom 里可能不来，按时长 + 余量的定时器兜底移除。
// - splash.css 有 6 秒的纯 CSS 兜底（脚本没跑起来也不会一直盖着）：兜底淡完以后（visibility: hidden）再调，直接移除。
// - 减少动态效果的判断照 src/motion/reduced.ts 的两条（系统设置或 <html data-rm="1">）；platform 层不能引 motion，这里另写一份。
// 调用点（src/app/main.tsx、src/app/root.tsx）：
//   ① 从启动起算 SPLASH_MAX_MS（5 秒）定时兜底：hideSplashAfter()
//   ② #root 里第一次画出东西（告知页关口有了结果：显示告知页，或者放行画 App；离线直接画 App；整屏提示；崩溃兜底页）
//      之后的下一帧：hideSplashWhenPainted(#root)
//   ③ App、整屏提示、崩溃兜底页 AppCrashFallback 提交以后的下一帧：root.tsx 的 SplashRelease
// “下一帧”由调用方传 motion 的 nextFrame（A25：requestAnimationFrame 只能写在 src/motion/，platform 又不能引 motion）

export const SPLASH_ID = 'lemo-splash';
/** splash.css 里 .lemo-splash.is-leaving 的过渡时长（ms）：--dur-ui 220；减少动态效果 120（splash.css 里启动画面专用的那个令牌） */
export const SPLASH_FADE_MS = 220;
export const SPLASH_FADE_RM_MS = 120;
/** 最多盖多久：从启动起算 5 秒（和告知页关口的上限一样，R-250） */
export const SPLASH_MAX_MS = 5000;
/** 定时器兜底比过渡多等一点 */
const SLACK_MS = 80;

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

/** 到点收起（从启动起算的兜底）；返回取消函数 */
export function hideSplashAfter(ms: number = SPLASH_MAX_MS): () => void {
  const t = setTimeout(() => void hideSplash(), ms);
  return () => clearTimeout(t);
}

/** 排到下一帧执行，返回取消函数（motion 的 nextFrame 就是这个形状）；不给时退回 setTimeout 0 */
export type FrameScheduler = (cb: () => void) => () => void;

const soon: FrameScheduler = (cb) => {
  const t = setTimeout(cb, 0);
  return () => clearTimeout(t);
};

/**
 * root 里第一次有内容（有元素子节点或非空白文本；React 画出了告知页、App、整屏提示或崩溃兜底页）以后的下一帧收起。
 * 告知页关口还在问服务器时关口什么也不画（root 是空的），启动画面就继续盖着；返回取消函数
 */
/** root 里真画出东西了：有元素子节点，或者有非空白文本（只有空白文本、注释节点不算，例如 index.html 格式化成 <div id="root"> 换行 </div>） */
function painted(root: Element): boolean {
  return root.firstElementChild !== null || /\S/.test(root.textContent ?? '');
}

export function hideSplashWhenPainted(root: Element, nextFrame: FrameScheduler = soon): () => void {
  let cancelFrame: (() => void) | null = null;
  const hide = () => nextFrame(() => void hideSplash());
  if (painted(root)) return hide();
  if (typeof MutationObserver !== 'function') return () => undefined;
  const mo = new MutationObserver(() => {
    if (!painted(root) || cancelFrame) return;
    mo.disconnect();
    cancelFrame = hide();
  });
  // 文本节点原地改写（空白改成文字）也要看到：characterData + subtree
  mo.observe(root, { childList: true, characterData: true, subtree: true });
  return () => {
    mo.disconnect();
    cancelFrame?.();
  };
}
