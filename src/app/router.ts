// 自写的轻量 hash 路由（架构 2.0）：/app/#/today。路由表集中在这里、带类型
// 页面超过约 15 个或要嵌套数据加载时，换成 React Router 的 hash 模式，改动只在这一个文件
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { transition } from '../motion/index.ts';

export const ROUTE_NAMES = [
  'today',
  'calendar',
  // 月历、周视图（B2 FA-3，架构 5.12）：#/cal/month/<年-月>、#/cal/week/<那周任一天>；底栏的 #/calendar 等于本月
  'cal',
  'todos',
  // 编辑页（B2 FA-2）：#/event/<id>、#/event/new，#/todo/<id>、#/todo/new
  'event',
  'todo',
  // “最近删除”（B2 FA-2，ADR-006）：#/trash
  'trash',
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

// 历史的深度标记（canGoBack 用）：放在 history.state 里，浏览器后退、刷新都还在
const DEPTH = 'lemoDepth';
function depthNow(): number {
  const st: unknown = window.history.state;
  const d = typeof st === 'object' && st !== null ? (st as Record<string, unknown>)[DEPTH] : undefined;
  return typeof d === 'number' && d > 0 ? d : 0;
}

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

// 两个路由是不是同一个页面（App 按登记表的 samePageAs 设，例如 #/calendar 和 #/cal/...）。
// 架构 5.12：页内切换不用 View Transition。浏览器在同一页里前进 / 后退（月历上个月 ↔ 下个月）也直接画，
// 不播 380ms 的整页淡入淡出（代码复审 R2）；路由器本身不认识功能登记表，所以由 App 注入
let samePage: (a: Route, b: Route) => boolean = () => false;

/** App 启动时调一次；测试里可以换 */
export function setSamePage(fn: (a: Route, b: Route) => boolean): void {
  samePage = fn;
}

/** hashchange 的 oldURL 里的 hash；没有（老浏览器、测试里手工派的事件）时返回 null，照常起动画 */
function oldHashOf(e: Event): string | null {
  const old = (e as HashChangeEvent).oldURL;
  if (typeof old !== 'string' || old === '') return null;
  const i = old.indexOf('#');
  return i < 0 ? '' : old.slice(i);
}

function onHashChange(e: Event): void {
  const now = window.location.hash;
  const skip = uaVisualHash !== null && uaVisualHash === now;
  uaVisualHash = null;
  const old = oldHashOf(e);
  const inPage = old !== null && samePage(parseHash(old), parseHash(now));
  void commit(undefined, !skip && !inPage);
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
    window.history.pushState({ [DEPTH]: depthNow() + 1 }, '', href);
  });
}

/** 同 navigate，但替换当前这条历史、不新压一条（直接打开的子页点“返回”回上一级时用，免得历史里叠一条子页） */
export function replaceRoute(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState({ [DEPTH]: depthNow() }, '', href);
  });
}

/**
 * 同一页面里换参数（月历翻月翻周、“今天”、年月选择、规整地址）：push 一条历史，但**不起 View Transition**，直接画新状态。
 * 页面自己决定要不要动（月历按钮翻页横滑、滑动跟手、键盘和“今天”直接切换，架构 5.12 第 3 点“动效”；B2 FA-3 代码复审 N1）
 */
export function navigateInPage(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.pushState({ [DEPTH]: depthNow() + 1 }, '', href);
  }, false);
}

/** 同 navigateInPage，但替换当前这条历史（键盘连按合并、非法参数规整） */
export function replaceInPage(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState({ [DEPTH]: depthNow() }, '', href);
  }, false);
}

/**
 * 退回上一条历史（和 iPhone 左边缘侧滑、浏览器后退同一条路）：页内子页（设置 › 注销账号）的“‹ 返回”用它，
 * 不再 push 一条“设置”，免得历史里叠出“设置、注销、设置”，侧滑又滑回注销页
 */
export function goBack(): void {
  window.history.back();
}

/**
 * 有没有“App 里的上一页”（代码审查 S11）：navigate 压的历史带深度标记，进 App 的第一页是 0。
 * 不用 history.length（从别的网站跳进来、同一个标签页之前开过别的页面时也大于 1，一后退就离开 App）
 */
export function canGoBack(): boolean {
  return depthNow() > 0;
}

/** 只改地址、不重画（新建保存后把 #/todo/new 换成这一条的 id，代码审查 S7）；深度不变 */
export function replaceAddress(name: RouteName, ...params: string[]): void {
  window.history.replaceState({ [DEPTH]: depthNow() }, '', hrefOf(name, ...params));
}
