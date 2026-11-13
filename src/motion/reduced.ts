// “减少动态效果”的唯一判断（架构 17.2 第 5 点；UI-4 M-1）：只看 <html data-rm="1">。
// data-rm 由 platform/look.ts 写：设置里的开关打开，或系统设置了 prefers-reduced-motion: reduce，任一条成立就写（系统切换时跟着改）。
// 函数（animateIn / animateOut / press / transition）和 React 组件（Appear、SharedLayout 经 useReducedMotionPref）
// 都只读这里；CSS 那一侧同样只认 :root[data-rm="1"]（全仓库只有启动画面 splash.css 自己看媒体查询：它要在 look.ts 加载前生效）
// 不引 React、不引 motion/react（index.ts 会被 router 带进首屏）

/** 现在要不要减少动态效果 */
export function prefersReducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset['rm'] === '1';
}

/** 订阅 data-rm 的改写；返回取消函数。给 useSyncExternalStore 用。
 * 单例（UI-4 第二轮 N-3、接手清单 M5，B2）：不管多少个订阅者（列表里成批的 <Appear>），整页只挂一个 MutationObserver；
 * 第一个订阅时挂上，最后一个退订时摘掉。回调按订阅顺序依次调；同一个函数订阅两次算两份，各自退订各自的 */
type Sub = { fn: () => void };
const subs = new Set<Sub>();
let observer: MutationObserver | null = null;

function emit(): void {
  // 先拷一份：回调里退订（组件卸载）不影响这一轮的其余订阅者
  for (const s of [...subs]) s.fn();
}

export function subscribeReducedMotion(onChange: () => void): () => void {
  const sub: Sub = { fn: onChange };
  subs.add(sub);
  if (!observer && typeof document !== 'undefined' && typeof MutationObserver === 'function') {
    observer = new MutationObserver(emit);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rm'] });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subs.delete(sub);
    if (subs.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}
