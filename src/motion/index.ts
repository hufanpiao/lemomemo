// 动效模块的对外接口：只有 src/motion 能用 motion/react、element.animate、
// document.startViewTransition、requestAnimationFrame（A25；切页不用 View Transition，见 ./page-swap.ts）
import type * as PageSwapModule from './page-swap.ts';
import { prefersReducedMotion } from './reduced.ts';

// React 组件（Appear、Pressable、SharedLayout）在 ./components.ts：
// 分开导出，免得只用函数的地方（例如 router 的 transition）把 motion/react 带进首屏
// 吞掉手势后补来的那一下 click（换页守卫、翻页、kit 左滑行、按住“＋”共用这一个；时限在 tokens.ts 的 TAP_SWALLOW_MS）
export { swallowNextClick, type SwallowClickOptions } from './swallow-click.ts';
export { TAP_SWALLOW_MS } from './tokens.ts';
// 时长令牌（秒）给要按动效时长排计时的地方读（例如待办勾完停留、收起，kit/components/useDoneFlow.ts），不另写一份毫秒数
export { dur } from './tokens.ts';
// 减少动态效果只有一套判断（系统设置或 <html data-rm="1">）；React 组件经 useReducedMotionPref 读同一个
export { prefersReducedMotion, subscribeReducedMotion } from './reduced.ts';
export type { AppearKind } from './presets.ts';
// 跟手手势（useSwipePager、useDragCollapse）在 ./gestures.ts：不从这里再导出，免得被首屏的 main 块带上

/**
 * 页面切换：进页新页从右边滑进来盖住旧页，back 为真（返回上一页、回上一层）反过来。
 * 实现在 ./page-swap.ts（和页签互切同一套引擎，底栏全程是真元素），首屏画完才下载；
 * 没到时直接换页、不播（冷启动不到一秒就点进下一页才碰得到）
 */
export function transition(update: () => void, back = false): Promise<void> {
  // 页签互切的淡入还在等分包时走了整页过渡（点了“＋”、头像）：先停掉，不然后面换上来的编辑页、设置页会被当成新页再淡入一次
  cancelFade();
  // 减少动态效果在门面先判（直接换页，不用等实现）：顺带让 reduced.ts 留在首屏 main 块里，不被拆成单独一个小块（拆开首屏反而大）
  if (swapImpl && !prefersReducedMotion()) return swapImpl.transition(update, back);
  void loadPageSwap();
  update();
  return Promise.resolve();
}

// 页签互切、“详细”长成的实现在 ./page-swap.ts，首屏画完以后才下载（放进首屏会超首屏预算）：
// main.tsx 和动画实现同一时机调 loadPageSwap；到之前换页直接换、不播（冷启动不到一秒就点页签才碰得到），“详细”直接进新建页
// 整个 app 唯一的 DOM 等待器和“页面出来”口径（显示着的 <main>）也在 ./page-shown.ts，留在首屏
export { FADE_GUARD_MS, FADE_SKIP_MS, FADE_WAIT_MS, GROW_HOLD, PAGE_SELECTOR, waitDom, whenMainShown } from './page-shown.ts';
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
/** 页签互切：和日历翻月同一份原地模糊淡换；part 为真只换页面里打了 data-swap-part 的那一栏（宽屏设置里换层）。实现没到时直接换 */
export function fadeSwap(update: () => void, part?: boolean): Promise<void> {
  if (swapImpl) return swapImpl.fadeSwap(update, part);
  void loadPageSwap();
  update();
  return Promise.resolve();
}
/** 打字条“详细”那张卡（card）长成新建页：卡的位置、圆角由实现量（page-swap.ts 的 growFrom）。实现没到时直接进新建页、当场收尾 */
export function growSwap(update: () => void, card: HTMLElement, landed: () => void): Promise<void> {
  if (swapImpl) return swapImpl.growFrom(update, card, landed);
  void loadPageSwap();
  update();
  landed();
  return Promise.resolve();
}
/** 停掉正在播的换页（没在播、实现没到时什么都不做） */
export function cancelFade(anim = true): void {
  swapImpl?.cancelFade(anim);
}

/** 下一帧执行（启动时的等帧、关启动画面、同步提示条；平台层的运行日志、视口修正经 app 层注入它）。每帧跑的循环在 ./frame-loop.ts 的 eachFrame */
export function nextFrame(cb: () => void): () => void {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
}

// 动画实现和功能包异步加载（./features.ts）：main.tsx 首屏画完以后调；测试里测“到了以后的手感”时也先等它到。
// features.ts 对 motion/react 只有类型引用，动画实现那一块是动态 import，不会把 motion/react 带进首屏
export { loadMotionFeatures } from './features.ts';
