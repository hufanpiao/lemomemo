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
  // 有订阅者时复用单例里那一个 MediaQueryList（代码审查 S9：成批的 <Appear> 一起渲染时不必每次 new 一个）
  return (shared ? shared.mql : systemQuery())?.matches === true;
}

/** 订阅两个来源的变化（系统设置切换、data-rm 改写）；返回取消函数。给 useSyncExternalStore 用。
 * 单例（UI-4 第二轮 N-3、接手清单 M5，B2）：不管多少个订阅者（列表里成批的 <Appear>），整页只挂一个 matchMedia 监听和
 * 一个 MutationObserver；第一个订阅时挂上，最后一个退订时摘掉（下一次订阅重新读 matchMedia，测试换假系统设置也认）。
 * 回调按订阅顺序依次调；同一个函数订阅两次算两份，各自退订各自的 */
type Sub = { fn: () => void };
const subs = new Set<Sub>();
let shared: { mql: MediaQueryList | null; observer: MutationObserver | null } | null = null;

function emit(): void {
  // 先拷一份：回调里退订（组件卸载）不影响这一轮的其余订阅者
  for (const s of [...subs]) s.fn();
}

function attach(): void {
  const mql = systemQuery();
  mql?.addEventListener('change', emit);
  let observer: MutationObserver | null = null;
  if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
    observer = new MutationObserver(emit);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rm'] });
  }
  shared = { mql, observer };
}

function detach(): void {
  shared?.mql?.removeEventListener('change', emit);
  shared?.observer?.disconnect();
  shared = null;
}

export function subscribeReducedMotion(onChange: () => void): () => void {
  const sub: Sub = { fn: onChange };
  subs.add(sub);
  if (!shared) attach();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subs.delete(sub);
    if (subs.size === 0) detach();
  };
}

