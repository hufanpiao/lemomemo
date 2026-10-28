// “减少动态效果”的唯一判断（架构 17.2 第 5 点；UI-4 M-1）：
// 系统设置 prefers-reduced-motion: reduce，或者设置里的开关 <html data-rm="1">，任一条成立就算。
// 函数（animateIn / animateOut / press / transition）和 React 组件（Appear、SharedLayout 经 useReducedMotionPref）
// 都只读这里；tokens.css 那一侧用的是同样两条（@media 和 :root[data-rm="1"]）
// 不引 React、不引 motion/react（index.ts 会被 router 带进首屏）

const QUERY = '(prefers-reduced-motion: reduce)';

function systemQuery(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia(QUERY) : null;
}

/** 现在要不要减少动态效果：data-rm="1" 或系统设置 */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset['rm'] === '1') return true;
  return systemQuery()?.matches === true;
}

/** 订阅两个来源的变化（系统设置切换、data-rm 改写）；返回取消函数。给 useSyncExternalStore 用 */
export function subscribeReducedMotion(onChange: () => void): () => void {
  const mql = systemQuery();
  mql?.addEventListener('change', onChange);
  let observer: MutationObserver | null = null;
  if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
    observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rm'] });
  }
  return () => {
    mql?.removeEventListener('change', onChange);
    observer?.disconnect();
  };
}
