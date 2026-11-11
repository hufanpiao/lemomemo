// #root 画出东西了没有（这类事只在这里判断，架构约定 10.1）：一个 MutationObserver 盯入口 watchRoot 挂上的根，对外三种等待——
// • whenContent(fn)：根里有内容（元素或非空白文本）；whenPage(fn)：根里有页面 <main>。都不等帧，现在就有就当场执行
// • afterAppPainted(fn) / appPainted()（首屏画完）：第一个页面出现再过一帧；render 后的时限（startAppPaintLimit）、挂上起的长兜底到了也算
// 不变量：App 外壳不放常驻 <main>（first-paint-shell.test.tsx）；没挂过 watchRoot（登录页、测试）时根退回 document.body、首屏画完当场算。
// “再过一帧”由调用方传 motion 的 nextFrame（A25：requestAnimationFrame 只许 src/motion 用）

export type FrameScheduler = (fn: () => void) => () => void;

/** 页面的选择器：任何 <main>（编辑页、整页提醒、告知页的根不带 data-feature 也算，FIRSTPAINT-nofeature；登记见 first-paint-pages.test.tsx） */
export const APP_PAGE_SELECTOR = 'main';
/** 首屏画完的时限：render 之后最多等这么久（入口按告知页关口的时限另传） */
export const APP_PAINT_LIMIT_MS = 4000;
/** 长兜底：从 watchRoot 挂上算（render 之前就走了、冷启动特别慢、后台标签 rAF 不跑时放行） */
export const APP_PAINT_BACKSTOP_MS = 15_000;

type Test = (el: Element) => boolean;
const hasContent: Test = (el) => el.firstElementChild !== null || /\S/.test(el.textContent ?? '');
const hasPage: Test = (el) => el.querySelector(APP_PAGE_SELECTOR) !== null;
/** 文本节点原地改写（空白改成文字）也要看到：characterData + subtree */
const OBSERVE: MutationObserverInit = { childList: true, characterData: true, subtree: true };

let root: Element | null = null;
const waits = new Set<{ test: Test; fn: () => void }>();
let mo: MutationObserver | null = null;
let painted = false;
const paintWaiters: (() => void)[] = [];
let limitTimer: ReturnType<typeof setTimeout> | null = null;

const target = (): Element => root ?? document.body;

function run(fn: () => void): void {
  try {
    fn();
  } catch {
    // 一个回调出错不挡别的
  }
}

function idle(): void {
  if (waits.size > 0) return;
  mo?.disconnect();
  mo = null;
}

function scan(): void {
  const el = target();
  for (const w of [...waits]) {
    if (!waits.has(w) || !w.test(el)) continue;
    waits.delete(w);
    run(w.fn);
  }
  idle();
}

function wait(test: Test, fn: () => void): () => void {
  if (test(target())) {
    fn();
    return () => undefined;
  }
  const w = { test, fn };
  waits.add(w);
  if (!mo && typeof MutationObserver === 'function') {
    mo = new MutationObserver(scan);
    mo.observe(target(), OBSERVE);
  }
  return () => {
    waits.delete(w);
    idle();
  };
}

/** 根里有内容（元素或非空白文本）时执行 fn：收起启动画面、卸“库被挡住”的整屏提示。返回取消函数 */
export const whenContent = (fn: () => void): (() => void) => wait(hasContent, fn);
/** 根里有页面（<main>）时执行 fn：底栏跟着页面出来、告知页之后等 App 自己的页面。返回取消函数 */
export const whenPage = (fn: () => void): (() => void) => wait(hasPage, fn);
/** 根里现在有页面吗 */
export const pageShown = (): boolean => hasPage(target());

function finish(): void {
  if (painted) return;
  painted = true;
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
  for (const fn of paintWaiters.splice(0)) run(fn);
}

/** 入口在 render 之前挂一次（重复调用不再挂）：定下根，开始算首屏画完；backstopMs 长兜底。返回取消函数（测试用） */
export function watchRoot(el: Element, nextFrame: FrameScheduler, backstopMs: number = APP_PAINT_BACKSTOP_MS): () => void {
  if (root) return () => undefined;
  root = el;
  mo?.observe(el, OBSERVE);
  let cancelFrame: (() => void) | null = null;
  const timer = setTimeout(finish, backstopMs);
  const stopPage = whenPage(() => {
    cancelFrame = nextFrame(() => {
      clearTimeout(timer);
      finish();
    });
  });
  return () => {
    stopPage();
    clearTimeout(timer);
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
    cancelFrame?.();
  };
}

/** render 之后调一次：再等最多 limitMs 就当首屏画完了。没挂过、已画完、已经开始计时的不再计 */
export function startAppPaintLimit(limitMs: number = APP_PAINT_LIMIT_MS): void {
  if (!root || painted || limitTimer !== null) return;
  limitTimer = setTimeout(finish, limitMs);
}

/** 首屏已经算画完了吗（没挂过 watchRoot 也算） */
export const isAppPainted = (): boolean => !root || painted;

/** 首屏画完以后执行 fn；已经画完、或者没挂过 watchRoot 时当场执行 */
export function afterAppPainted(fn: () => void): void {
  if (isAppPainted()) fn();
  else paintWaiters.push(fn);
}

/** 同上，Promise 写法（入口里 await 用） */
export function appPainted(): Promise<void> {
  return new Promise((ok) => afterAppPainted(ok));
}

/** 测试用 */
export function resetRootPaintForTest(): void {
  root = null;
  painted = false;
  paintWaiters.length = 0;
  waits.clear();
  idle();
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
}
