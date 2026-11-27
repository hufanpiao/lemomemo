// 页面显示出来没有、等 DOM 变成某个样子（这类事只在这里判断；整个 app 只有这一个 DOM 等待器 waitDom）和换页动画的常量。
// “页面出来”只有一个口径：有显示着的 <main>（shownMain）。冷启动首屏画完、底栏跟着页面出来、提醒等 App 自己的页（app/first-paint.ts、App.tsx），
// 换页等新页（page-swap.ts）都用它。留在首屏：动画实现 page-swap.ts 首屏画完以后才下载
const noop = (): void => undefined;

/** 页面的选择器：任何 <main>（编辑页、整页提醒、告知页的根不带 data-feature 也算；登记见 first-paint-pages.test.tsx） */
export const PAGE_SELECTOR = 'main';

/** 新页分包还没到（页面的 Suspense 先什么都不画）时，最多等多久让它出来；过了就不动画了（App 等页面显示出来也用这个数） */
export const FADE_WAIT_MS = 1500;
/** 新页从第几毫秒起播（一帧，60Hz）：不画 opacity 0 的那一帧 */
export const FADE_SKIP_MS = 1000 / 60;
/** 换页后吞点按的窗口：定义和理由在 tokens.ts（吞点按的毫秒数都在那一处），这里照旧导出给 index.ts 和测试 */
export { FADE_GUARD_MS } from './tokens.ts';
/** “详细”长成的前多少（比例）新建页内容不露、打字条淡完 */
export const GROW_HOLD = 0.35;
/**
 * 这个元素此刻画在页面上没有（还在文档里、没被 display: none 藏起来）。新页分包没到时 Suspense 用内联 display: none 藏旧页、
 * 旧页仍在文档里（React 19 + flushSync），只看 isConnected 判断不出来。
 * 换页动画等新页、显示旧页快照，首屏画完、App 等页面显示出来，都用这一个判断（“首屏画完”这个标志存在 platform/root-paint.ts）
 */
export function pageVisible(el: Element | null): boolean {
  return el !== null && el.isConnected && el.getClientRects().length > 0;
}

/** 页面上第一个显示着的 <main>（真页面；快照外壳不是 main） */
export function shownMain(): HTMLElement | null {
  for (const m of document.querySelectorAll<HTMLElement>(PAGE_SELECTOR)) if (pageVisible(m)) return m;
  return null;
}

/** 增删节点、文本原地改写（空白改成文字，#root 画出东西了没有）、Suspense 改内联 display、hidden 都要看到 */
const OBSERVE: MutationObserverInit = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'hidden'] };

/**
 * 看着 body 等 test() 成立就调 hit(true)；已经成立就当场调；ms 内一直不成立调 hit(false)，ms 为 Infinity 就一直等。返回停止（停了不再调 hit）。
 * 换页等新页、首屏画完、底栏和提醒等页面、#root 画出东西（app/first-paint.ts）都用这一个
 */
export function waitDom(test: () => boolean, ms: number, hit: (ok: boolean) => void): () => void {
  if (test()) {
    hit(true);
    return noop;
  }
  let live = true;
  const stop = (): void => {
    if (!live) return;
    live = false;
    mo.disconnect();
    clearTimeout(timer);
  };
  const mo = new MutationObserver(() => {
    if (!test()) return;
    stop();
    hit(true);
  });
  // setTimeout 收到 Infinity 会当 0、马上到点：一直等就不起定时器
  const timer = ms === Infinity ? undefined : setTimeout(() => {
    stop();
    hit(false);
  }, ms);
  mo.observe(document.body, OBSERVE);
  return stop;
}

/** 有显示着的页面 <main> 就调 fn（已经有就当场调）；ms 内一直没有也调（不传就一直等）。返回取消 */
export const whenMainShown = (fn: () => void, ms = Infinity): (() => void) => waitDom(() => shownMain() !== null, ms, fn);
