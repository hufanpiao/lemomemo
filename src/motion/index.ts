// 动效模块的对外接口（架构 17.2 第 4 点）：只有这里能用 motion/react、element.animate、
// document.startViewTransition、requestAnimationFrame（A25）
// B0 是骨架：接口定下来，具体手感在 B1（按下回弹、页面切换）、B2（弹层、列表）、B3（提示条、录音面板）里调
import { presets, PRESS_SCALE, type AppearKind } from './presets.ts';
import { prefersReducedMotion } from './reduced.ts';
import { dur, ease, type Bezier } from './tokens.ts';

// React 组件（Appear、Pressable、SharedLayout、Celebrate）在 ./components.ts：
// 分开导出，免得只用函数的地方（例如 router 的 transition）把 motion/react 带进首屏（2.6）
export { vtName } from './vt.ts';
// 减少动态效果只有一套判断（系统设置或 <html data-rm="1">，UI-4 M-1）；React 组件经 useReducedMotionPref 读同一个
export { prefersReducedMotion, subscribeReducedMotion } from './reduced.ts';
export type { AppearKind } from './presets.ts';

const bezierCss = (b: Bezier): string => `cubic-bezier(${b.join(',')})`;


function run(el: Element, kind: AppearKind, dir: 'in' | 'out'): Promise<void> {
  const p = presets[kind];
  const reduced = prefersReducedMotion();
  const from = dir === 'in' ? p.initial : p.animate;
  const to = dir === 'in' ? p.animate : p.exit;
  const frames: Keyframe[] = reduced
    ? [{ opacity: dir === 'in' ? 0 : 1 }, { opacity: dir === 'in' ? 1 : 0 }]
    : [
        { opacity: from.opacity, transform: from.transform },
        { opacity: to.opacity, transform: to.transform },
      ];
  const ms = (p.transition.duration * 1000) / (reduced ? 2 : 1);
  if (typeof el.animate !== 'function') return Promise.resolve();
  const a = el.animate(frames, { duration: ms, easing: bezierCss(p.transition.ease), fill: 'both' });
  return a.finished.then(() => undefined, () => undefined);
}

/** 非 React 场景的进场 */
export function animateIn(el: Element, kind: AppearKind): Promise<void> {
  return run(el, kind, 'in');
}

/** 非 React 场景的离场（返回的 Promise 在动画播完后完成，可以接着移除元素） */
export function animateOut(el: Element, kind: AppearKind): Promise<void> {
  return run(el, kind, 'out');
}

/** 按下回弹：scale(0.97)，松开用 --ease-spring 弹回 */
export function press(el: Element): Promise<void> {
  if (prefersReducedMotion() || typeof el.animate !== 'function') return Promise.resolve();
  const a = el.animate(
    [{ transform: 'scale(1)' }, { transform: `scale(${PRESS_SCALE})` }, { transform: 'scale(1)' }],
    { duration: dur.press * 1000 * 2, easing: bezierCss(ease.spring) },
  );
  return a.finished.then(() => undefined, () => undefined);
}

interface VtDocument {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> };
}

/** 页面切换：支持 View Transitions 就包一层，不支持或减少动态效果时直接执行（17.2 第 3 点） */
export function transition(update: () => void): Promise<void> {
  const doc = typeof document === 'undefined' ? undefined : (document as Document & VtDocument);
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return Promise.resolve();
  }
  return doc.startViewTransition(update).finished.then(() => undefined, () => undefined);
}

/** 以后的趣味动效从这里接入；4.0.0 什么都不做（17.2 第 4、7 点） */
export function celebrate(kind: string): void {
  void kind;
}

/** 下一帧执行（给以后的帧循环用，例如液态玻璃副本，0.27 第 5 点） */
export function nextFrame(cb: () => void): () => void {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
}
