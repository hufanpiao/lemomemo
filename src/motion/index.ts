// 动效模块的对外接口（架构 17.2 第 4 点）：只有这里能用 motion/react、element.animate、
// document.startViewTransition、requestAnimationFrame（A25）
// B0 是骨架：接口定下来，具体手感在 B1（按下回弹、页面切换）、B2（弹层、列表）、B3（提示条、录音面板）里调
import type * as PageSwapModule from './page-swap.ts';
import { prefersReducedMotion } from './reduced.ts';
import { reportDuplicateVtNames } from './vt.ts';

// React 组件（Appear、Pressable、SharedLayout、Celebrate）在 ./components.ts：
// 分开导出，免得只用函数的地方（例如 router 的 transition）把 motion/react 带进首屏（2.6）
export { vtName } from './vt.ts';
// 吞掉手势后补来的那一下 click（换页守卫、翻页、kit 左滑行、按住“＋”共用这一个；时限在 tokens.ts 的 TAP_SWALLOW_MS）
export { swallowNextClick, type SwallowClickOptions } from './swallow-click.ts';
export { TAP_SWALLOW_MS } from './tokens.ts';
// 时长令牌（秒）给要按动效时长排计时的地方读（例如待办勾完停留、收起，kit/components/useDoneFlow.ts），不另写一份毫秒数
export { dur } from './tokens.ts';
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

// 页签互切、“详细”长成的实现在 ./page-swap.ts（11-18 独立评审后整块重写），首屏画完以后才下载（11-18 ci 首屏预算 151.7 KB 超线后挪出）：
// main.tsx 和动画实现同一时机调 loadPageSwap；到之前换页直接换、不播（冷启动不到一秒就点页签才碰得到），“详细”直接进新建页
export { FADE_GUARD_MS, FADE_SKIP_MS, FADE_WAIT_MS, GROW_HOLD, SLIDE_IN_PCT, SLIDE_OUT_PCT, pageVisible, shownMain, waitDom } from './page-shown.ts';
type PageSwap = typeof PageSwapModule;
let swapImpl: PageSwap | null = null;
let swapLoad: Promise<void> | null = null;
/** 下载换页动画实现；失败不抛，下次换页再试 */
export function loadPageSwap(): Promise<void> {
  swapLoad ??= import('./page-swap.ts').then(
    (m) => {
      swapImpl = m;
    },
    () => {
      swapLoad = null;
    },
  );
  return swapLoad;
}
/** 页签互切：按底栏顺序左右滑入（实现没到时直接换） */
export function fadeSwap(update: () => void, dir: 1 | -1 = 1): Promise<void> {
  if (swapImpl) return swapImpl.fadeSwap(update, dir);
  void loadPageSwap();
  update();
  return Promise.resolve();
}
/** 打字条“详细”那张卡长成新建页（实现没到时直接进新建页、当场收尾） */
export function growSwap(update: () => void, from: DOMRect, radius: number, card: Element | null, landed: () => void): Promise<void> {
  if (swapImpl) return swapImpl.growSwap(update, from, radius, card, landed);
  void loadPageSwap();
  update();
  landed();
  return Promise.resolve();
}
/** 停掉正在播的换页（没在播、实现没到时什么都不做） */
export function cancelFade(anim = true): void {
  swapImpl?.cancelFade(anim);
}

/** 下一帧执行（给以后的帧循环用，例如液态玻璃副本，0.27 第 5 点） */
export function nextFrame(cb: () => void): () => void {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
}

// 动画实现和功能包异步加载（B2 FA-6 ②、R-354，./features.ts）：main.tsx 首屏画完以后调；测试里测“到了以后的手感”时也先等它到。
// features.ts 对 motion/react 只有类型引用，动画实现那一块是动态 import，不会把 motion/react 带进首屏
export { loadMotionFeatures } from './features.ts';
