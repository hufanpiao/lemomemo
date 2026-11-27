// 电脑上用鼠标时的滚动条：平时藏起，哪块区域在滚就在那块浮出柠檬黄细条，停下 HIDE_MS 后淡去。
// 样式在 styles/base.css 的 html[data-sb] 一段：只有装上这里（html 带 data-sb）才藏，没装上浏览器照旧显示原生滚动条。
// 触屏不装（base.css 在 pointer: coarse 下本来就藏整页滚动条）。
// 浮出、淡去用 WAAPI 动注册过的 --sb-c（--dur-ui、--ease-out）：不写成 CSS 过渡，免得给页面上所有元素挂 transition。
// 减少动态效果（reduced.ts）或浏览器没有 element.animate 时直接出现、直接消失。
import { prefersReducedMotion } from './reduced.ts';
import { bezierCss, dur, ease } from './tokens.ts';

/** 停止滚动多久以后开始淡去 */
export const HIDE_MS = 800;

type Fade = { timer: ReturnType<typeof setTimeout>; anim: Animation | null; fading: boolean };

/** 装上滚动监听；返回卸载函数（测试用） */
export function installScrollbarReveal(doc: Document = document): () => void {
  const root = doc.documentElement;
  const state = new Map<Element, Fade>();

  const motion = (): KeyframeAnimationOptions | null =>
    prefersReducedMotion() ? null : { duration: dur.ui * 1000, easing: bezierCss(ease.out) };

  const play = (el: Element, kf: Keyframe[], opt: KeyframeAnimationOptions | null): Animation | null =>
    opt && typeof el.animate === 'function' ? el.animate(kf, opt) : null;

  const hide = (el: Element): void => {
    const s = state.get(el);
    if (!s) return;
    s.anim?.cancel();
    const end = (): void => {
      el.removeAttribute('data-sb-on');
      state.delete(el);
    };
    // 只给终点：起点是现在的颜色；fill 留住透明，摘掉属性时一起取消
    const m = motion();
    const anim = play(el, [{ '--sb-c': 'transparent', offset: 1 }], m && { ...m, fill: 'forwards' });
    if (!anim) return end();
    s.anim = anim;
    s.fading = true;
    anim.onfinish = () => {
      end();
      anim.cancel();
    };
  };

  const onScroll = (e: Event): void => {
    const t = e.target;
    const el = t === doc ? (doc.scrollingElement ?? root) : t instanceof Element ? t : null;
    if (!el) return;
    const s = state.get(el);
    const timer = setTimeout(() => hide(el), HIDE_MS);
    if (!s) {
      el.setAttribute('data-sb-on', '');
      state.set(el, { timer, anim: play(el, [{ '--sb-c': 'transparent', offset: 0 }], motion()), fading: false });
      return;
    }
    clearTimeout(s.timer);
    s.timer = timer;
    // 淡去中又滚了：停掉淡去，回到亮着（浮出那段动画让它放完，连续滚动不打断）
    if (s.fading) {
      s.anim?.cancel();
      s.anim = null;
      s.fading = false;
    }
  };

  // 元素自己的 scroll 不冒泡，捕获阶段在 document 上一处接住所有滚动区域
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  root.setAttribute('data-sb', '');

  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    root.removeAttribute('data-sb');
    for (const [el, s] of state) {
      clearTimeout(s.timer);
      s.anim?.cancel();
      el.removeAttribute('data-sb-on');
    }
    state.clear();
  };
}
