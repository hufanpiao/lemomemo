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

/** 改地址（可选）并同步把新页面画完；animate 为 true 时包在 View Transition 里 */
function commit(change?: () => void, animate = true): Promise<void> {
  const update = (): void => {
    change?.();
    flushSync(notifyAll);
  };
  if (!animate) {
    update();
    return Promise.resolve();
  }
  return transition(update);
}

// UI-4 第二轮 N-1：iPhone Safari 左边缘侧滑返回时系统自己已经播了返回动画（popstate.hasUAVisualTransition 为 true），
// 再起 View Transition 会叠一次交叉淡入淡出。浏览器先派 popstate、紧接着派 hashchange：
// popstate 里记下这个标记和当时的地址，hashchange 只有地址对得上才用它，是侧滑就不包动画、直接画新页面。
// 两条历史 hash 相同时只有 popstate 没有 hashchange：标记会留着，但之后点链接来的 hashchange 地址对不上，不会被误跳过
let uaVisualHash: string | null = null;

function onPopState(e: PopStateEvent): void {
  // 老浏览器没有这个属性，当 false
  const ua = (e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
  uaVisualHash = ua ? window.location.hash : null;
}

function onHashChange(): void {
  const skip = uaVisualHash !== null && uaVisualHash === window.location.hash;
  uaVisualHash = null;
  void commit(undefined, !skip);
}

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onHashChange);
      uaVisualHash = null;
    }
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
 * 用 history.pushState 同步改地址（不触发 hashchange，不会重复切换），再 flushSync 让 React 在回调里画完新页面。
 * 已经在这一页（地址没变）就直接返回：不起空 transition，免得切换期间约 0.25 秒点按被吞掉（UI-4 第二轮 N-2）
 */
export function navigate(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.pushState(null, '', href);
  });
}

/** 同 navigate，但替换当前这条历史、不新压一条（直接打开的子页点“返回”回上一级时用，免得历史里叠一条子页） */
export function replaceRoute(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState(null, '', href);
  });
}

/**
 * 退回上一条历史（和 iPhone 左边缘侧滑、浏览器后退同一条路）：页内子页（设置 › 注销账号）的“‹ 返回”用它，
 * 不再 push 一条“设置”，免得历史里叠出“设置、注销、设置”，侧滑又滑回注销页
 */
export function goBack(): void {
  window.history.back();
}
