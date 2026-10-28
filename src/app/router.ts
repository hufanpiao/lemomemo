// 自写的轻量 hash 路由（架构 2.0）：/app/#/today。路由表集中在这里、带类型
// 页面超过约 15 个或要嵌套数据加载时，换成 React Router 的 hash 模式，改动只在这一个文件
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { transition } from '../motion/index.ts';

export const ROUTE_NAMES = [
  'today',
  'calendar',
  'todos',
  'notes',
  'vault',
  'anniv',
  'settings',
  'onboarding',
  'dev-csp',
] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

export interface Route {
  name: RouteName;
  /** 路径里名字后面的部分，例如 #/notes/abc 的 ['abc'] */
  params: readonly string[];
}

export const DEFAULT_ROUTE: Route = { name: 'today', params: [] };

const isRouteName = (s: string): s is RouteName => (ROUTE_NAMES as readonly string[]).includes(s);

/** '#/notes/abc' → {name: 'notes', params: ['abc']}；认不出来的回今天页 */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head = '', ...rest] = path.split('/').filter((x) => x !== '');
  if (!isRouteName(head)) return DEFAULT_ROUTE;
  return { name: head, params: rest.map((x) => decodeURIComponent(x)) };
}

/** 路由 → href（A26：JSX 里的 href 只能是常量、hrefOf() 或 safeHref() 的返回值） */
export function hrefOf(name: RouteName, ...params: string[]): string {
  const tail = params.map((p) => `/${encodeURIComponent(p)}`).join('');
  return `#/${name}${tail}`;
}

// ───────── 路由状态和页面切换（17.2 第 3 点；UI-4 M-2）─────────
// React 读的是 location.hash，但只在我们通知时才重画：页面切换包在 motion.transition()（View Transitions）里，
// 回调里同步改地址并 flushSync 通知，回调一返回新页面就已经画完，浏览器截“新画面”不会截到旧页面。
// 浏览器的前进 / 后退（hashchange）走同一条路；一次切换只起一个 View Transition（监听器集中在这里）

const listeners = new Set<() => void>();

function notifyAll(): void {
  for (const l of [...listeners]) l();
}

/** 改地址（可选）并同步把新页面画完；包在 View Transition 里 */
function commit(change?: () => void): Promise<void> {
  return transition(() => {
    change?.();
    flushSync(notifyAll);
  });
}

function onHashChange(): void {
  void commit();
}

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('hashchange', onHashChange);
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) window.removeEventListener('hashchange', onHashChange);
  };
}

const getHash = (): string => window.location.hash;

/** 当前路由（hash 不变时返回值也稳定：比较的是字符串） */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  return parseHash(hash);
}

/**
 * 跳到某个路由；页面切换包在 View Transitions 里（17.2 第 3 点）。
 * 用 history.pushState 同步改地址（不触发 hashchange，不会重复切换），再 flushSync 让 React 在回调里画完新页面
 */
export function navigate(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  return commit(() => {
    if (window.location.hash !== href) window.history.pushState(null, '', href);
  });
}
