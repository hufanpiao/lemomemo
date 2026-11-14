// 动效模块的对外接口（架构 17.2 第 4 点）：只有这里能用 motion/react、element.animate、
// document.startViewTransition、requestAnimationFrame（A25）
// B0 是骨架：接口定下来，具体手感在 B1（按下回弹、页面切换）、B2（弹层、列表）、B3（提示条、录音面板）里调
import { prefersReducedMotion } from './reduced.ts';
import { swallowNextClick } from './swallow-click.ts';
import { bezierCss, dur, ease } from './tokens.ts';
import { reportDuplicateVtNames } from './vt.ts';

// React 组件（Appear、Pressable、SharedLayout、Celebrate）在 ./components.ts：
// 分开导出，免得只用函数的地方（例如 router 的 transition）把 motion/react 带进首屏（2.6）
export { vtName } from './vt.ts';
// 吞掉手势后补来的那一下 click（换页守卫、翻页、kit 左滑行、按住“＋”共用这一个；时限在 tokens.ts 的 TAP_SWALLOW_MS）
export { swallowNextClick, type SwallowClickOptions } from './swallow-click.ts';
export { TAP_SWALLOW_MS } from './tokens.ts';
// 减少动态效果只有一套判断（系统设置或 <html data-rm="1">，UI-4 M-1）；React 组件经 useReducedMotionPref 读同一个
export { prefersReducedMotion, subscribeReducedMotion } from './reduced.ts';
export type { AppearKind } from './presets.ts';
// 跟手手势（useSwipePager、useDragCollapse）在 ./gestures.ts：不从这里再导出，免得被首屏的 main 块带上（11-05 主持人定，首屏体积）

interface VtDocument {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> };
}

/** Pressable 在 DOM 上的标记（Pressable.tsx 写 data-pressable；data-snap 的样式在 Pressable.module.css） */
const PRESSABLE_SEL = '[data-pressable]';
const SNAP_ATTR = 'data-snap';

/** 切页前把页面上所有 Pressable 瞬间复位（UI-4 B1 动效确认 C3 / X-3）：
 * 点完按钮马上切页时，按钮还缩着或正在弹回，浏览器截旧画面会截到这一刻、淡出时定格（36319a2 查到的根因）。
 * 统一在这里处理，不再每个按钮局部改：打 data-snap 去掉过渡、回到原大小，旧画面截的是复位后的样子；
 * View Transition 的回调里（旧画面已经截完、新页面画之前）摘掉 */
function snapPressables(doc: Document, on: boolean): void {
  for (const el of doc.querySelectorAll(on ? PRESSABLE_SEL : `[${SNAP_ATTR}]`)) {
    if (on) el.setAttribute(SNAP_ATTR, '');
    else el.removeAttribute(SNAP_ATTR);
  }
}

/**
 * 过渡期间给 <html> 打 data-vt（11-06 代码审查 S4）：iOS 18.0～18.1 有 startViewTransition 但不认 :active-view-transition，
 * 要按“正在过渡”写的样式或测试认这个属性。原来底栏“过渡中换实色”的 CSS 用它，11-06 实色已经去掉（负责人真机 9d40848），
 * 页签互切也不再起 View Transition（fadeSwap 不打这个属性）；现在只有整页 View Transition 时打，CSS 里暂时没有规则用它。
 * 旧画面在调用 startViewTransition 之后才截，所以要在调用之前打上；新过渡打断旧过渡时，旧的 finished 先结束，用计数，最后一个结束才摘
 */
let vtOpen = 0;
function markVt(doc: Document, on: boolean): void {
  vtOpen = Math.max(0, vtOpen + (on ? 1 : -1));
  if (vtOpen > 0) doc.documentElement.setAttribute('data-vt', '');
  else doc.documentElement.removeAttribute('data-vt');
}

/** 页面切换：支持 View Transitions 就包一层，不支持或减少动态效果时直接执行（17.2 第 3 点） */
export function transition(update: () => void): Promise<void> {
  // 页签互切的淡入还在等分包时走了整页过渡（点了“＋”、头像）：先停掉，不然后面换上来的编辑页、设置页会被当成新页再淡入一次（代码审查方案 B M9）
  cancelFade();
  const doc = typeof document === 'undefined' ? undefined : (document as Document & VtDocument);
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return Promise.resolve();
  }
  snapPressables(doc, true);
  markVt(doc, true);
  let vt: { finished: Promise<void> };
  try {
    vt = doc.startViewTransition(() => {
      snapPressables(doc, false);
      update();
      // 开发版：新页面画完就查 view-transition-name 重名（17.2 第 3 点；X-5 改成读计算样式，CSS Modules 起的名字也查得到）
      if (import.meta.env.DEV) reportDuplicateVtNames(doc);
    });
  } catch {
    // startViewTransition 同步抛错（个别实现、以后加的包装；代码审查 S2）：摘掉标记、直接画新页面，
    // 不然 data-snap 一直留着，所有 Pressable 都没了按下反馈
    snapPressables(doc, false);
    markVt(doc, false);
    update();
    return Promise.resolve();
  }
  const done = (): void => markVt(doc, false);
  return vt.finished.then(done, done);
}

/** 新页分包还没到（页面的 Suspense 先什么都不画）时，最多等多久让它出来再淡入；过了就不淡了 */
export const FADE_WAIT_MS = 1500;
/** 淡入从第几毫秒起播（一帧，60Hz）：不画 opacity 0 的那一帧 */
export const FADE_SKIP_MS = 1000 / 60;
/**
 * 换页后这么久以内落在 main 里的点按吞掉（代码审查方案 B M8；沿用主持人 11-05 的规则“过渡开始很短时间内的点按算点在旧画面上”）：
 * 旧页在点页签那一刻就卸掉了，手指顺手再点一下原来那页的位置，人还没看清新页，会直接点中新页同一位置的删除 ×、勾选圈。
 * 原来 R6 的 EARLY_MS 是 50 ms；这里取 100 ms（新页第一帧约 17 ms 才画出来，再加人眼看清的最短时间），底栏不在 main 里，连点页签不受影响
 */
export const FADE_GUARD_MS = 100;
let fadeAnim: Animation | null = null;
let fadeStop: (() => void) | null = null;
let guardStop: (() => void) | null = null;

/**
 * 在 document 上用 capture 吞掉 ms 以内落在 main 里的 pointerdown、click；返回摘掉监听的函数。
 * 窗口里吞掉了 pointerdown 时，跟着的那次 click 晚到窗口外（按下在窗口里、松开在窗口外）也吞：交给 swallowNextClick，
 * 最多等 TAP_SWALLOW_MS（从按下算）；新的一次按下、被吞的按下变成滚动（pointercancel）就不再等（代码审查 S12，在 swallowNextClick 里）。
 * 吞用 stopImmediatePropagation（document 上后挂的捕获监听也收不到）；键盘的 click（窗口里先有 keydown，焦点在按钮上按回车、空格）不是手指点在旧画面上，不吞
 * （R-420 审查第 13 条；不按 detail === 0 认键盘，理由见 swallow-click.ts）
 */
function guardTaps(doc: Document, ms: number): () => void {
  const t0 = performance.now();
  let late: (() => void) | null = null;
  /** 窗口里按过键盘：随后的 click 是键盘点的 */
  let keyed = false;
  const mainOf = (e: Event): Element | null => (e.target instanceof Element ? e.target.closest('main') : null);
  const eat = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const down = (e: Event): void => {
    if (performance.now() - t0 >= ms) return void stop();
    const main = mainOf(e);
    if (!main) return;
    eat(e);
    late?.();
    late = swallowNextClick({ within: main });
  };
  const click = (e: Event): void => {
    if (performance.now() - t0 >= ms) return void stop();
    if (keyed) keyed = false;
    else if (mainOf(e)) eat(e);
  };
  const key = (): void => {
    keyed = true;
  };
  const timer = setTimeout(() => stop(), ms);
  let dead = false;
  /** 窗口到了：只摘窗口本身的监听，晚到的那一下还由 late 等着 */
  const stop = (): void => {
    if (dead) return;
    dead = true;
    clearTimeout(timer);
    doc.removeEventListener('pointerdown', down, true);
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('keydown', key, true);
  };
  /** 下一次换页、cancelFade：连晚到的那一下也不再等 */
  const off = (): void => {
    stop();
    late?.();
    if (guardStop === off) guardStop = null;
  };
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('click', click, true);
  doc.addEventListener('keydown', key, true);
  return off;
}

/**
 * 停掉页签互切的淡入（代码审查方案 B M9）：还在等分包的观察器、换页后吞点按的窗口；anim 为 true 时连正在播的淡入也取消（opacity 回到 1）。
 * transition() 开头调（整页过渡要截的是完整的旧画面）；路由同页内切换（commit 的 none）调 cancelFade(false)：只停等待，不打断正在播的淡入
 */
export function cancelFade(anim = true): void {
  fadeStop?.();
  guardStop?.();
  if (!anim) return;
  fadeAnim?.cancel();
  fadeAnim = null;
}

/**
 * 四个页签之间互切（负责人 11-06 选方案 B，B2-动效审查-切页先出后入.md 第四批）：不起 View Transition，
 * 底栏、“＋”、液滴、顶部两层模糊一直是真元素、一直实时模糊（WebKit bug 302256：过渡期间不画 backdrop-filter），液滴连续滑。
 * 新页直接换上（update 同步画完，旧页已经卸掉，两页不同时在屏上），再给新页的 main 做一次 opacity 0→1（--dur-ui、--ease-out）。
 * 连点：取消上一次还没播完的淡入（和还在等分包的那一次）；减少动态效果时只换页、不动。
 * pick 找页面的 main。新页分包没到时 React 先留着旧页（webkit e2e 实测第一次切到待办约 50 ms），pick 还是旧的那个：
 * 换页前先记下旧的，只认换上来的新元素；还没出来就看着 body 等，最多 FADE_WAIT_MS；等的时候走了整页过渡或同页内切换，cancelFade 停掉（M9）。
 * 换页后 FADE_GUARD_MS 以内落在 main 里的点按吞掉（M8）。
 * 返回的 Promise 等淡入放完（约 220 ms）才 resolve，比原来的 View Transition 早一点结束；等分包时 await 完拿到的可能是还没淡完的页（代码审查 L20）
 */
export function fadeSwap(update: () => void, pick: () => Element | null): Promise<void> {
  cancelFade();
  const before = pick();
  update();
  if (typeof document === 'undefined') return Promise.resolve();
  // 换页后先吞一小会儿点按（M8）；减少动态效果时也吞：旧页一样是瞬间没的
  guardStop = guardTaps(document, FADE_GUARD_MS);
  if (prefersReducedMotion()) return Promise.resolve();
  const play = (el: Element): Promise<void> => {
    if (typeof el.animate !== 'function') return Promise.resolve();
    const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur.ui * 1000, easing: bezierCss(ease.out) });
    // 跳过第一帧：从 0 起播时画出来的第一帧整页透明，只剩底色和底栏，等于一帧空白（11-06 chromium 逐帧实测）；从一帧以后起，第一帧约 0.3
    a.currentTime = FADE_SKIP_MS;
    fadeAnim = a;
    const done = (): void => {
      if (fadeAnim === a) fadeAnim = null;
    };
    return a.finished.then(done, done);
  };
  const fresh = (): Element | null => {
    const el = pick();
    return el !== null && el !== before ? el : null;
  };
  const now = fresh();
  if (now) return play(now);
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      mo.disconnect();
      clearTimeout(timer);
      if (fadeStop === stop) fadeStop = null;
      resolve();
    };
    const mo = new MutationObserver(() => {
      const el = fresh();
      if (!el) return;
      stop();
      // 分包晚到：新页这时才出来，吞点按的窗口从这一刻重新算
      guardStop?.();
      guardStop = guardTaps(document, FADE_GUARD_MS);
      void play(el);
    });
    const timer = setTimeout(stop, FADE_WAIT_MS);
    fadeStop = stop;
    mo.observe(document.body, { childList: true, subtree: true });
  });
}

/** 下一帧执行（给以后的帧循环用，例如液态玻璃副本，0.27 第 5 点） */
export function nextFrame(cb: () => void): () => void {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
}

// 动画实现和功能包异步加载（B2 FA-6 ②、R-354，./features.ts）：main.tsx 首屏画完以后调；测试里测“到了以后的手感”时也先等它到。
// features.ts 对 motion/react 只有类型引用，动画实现那一块是动态 import，不会把 motion/react 带进首屏
export { loadMotionFeatures } from './features.ts';
