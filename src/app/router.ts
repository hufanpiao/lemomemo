// 自写的轻量 hash 路由（架构 2.0）：/app/#/today。路由表集中在这里、带类型
// 页面超过约 15 个或要嵌套数据加载时，换成 React Router 的 hash 模式，改动只在这一个文件
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { cancelFade, fadeSwap, transition } from '../motion/index.ts';

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
  // 整页提醒（B2 FA-4，REMIND-wiring）：#/remind/<kind>/<id>?due=<dueAt>。地址只由 openReminder / reminderHash
  // （shared/logic/remind-route.ts）生成，不用 hrefOf（会把 ?due= 转义掉）；页面自己用 parseReminderHash 校验
  'remind',
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

/** 切页怎么动：vt 整页 View Transition；fade 四个页签互切，不起 View Transition、新页淡入（motion 的 fadeSwap）；none 直接画 */
type Anim = 'vt' | 'fade' | 'none';

/** 改地址（可选）并同步把新页面画完；按 anim 包一层动画 */
function commit(change?: () => void, anim: Anim = 'vt'): Promise<void> {
  const update = (): void => {
    change?.();
    flushSync(notifyAll);
  };
  if (anim === 'none') {
    cancelFade(false); // 页签互切的淡入还在等分包：停掉，同页内换上来的不是它要等的页（代码审查方案 B M9）
    update();
    return Promise.resolve();
  }
  if (anim === 'fade') return fadeSwap(update, () => document.querySelector('main'));
  return transition(update);
}

// 两个路由是不是“四个页签之间互切”（App 按 tab-of.ts 设：两头都有底栏、页签不同）。负责人 11-06 选方案 B：
// 页签互切不走 View Transition，底栏、液滴、顶部模糊一直实时模糊（WebKit 过渡期间不画 backdrop-filter，bug 302256）；
// 别的切页（进编辑页、设置……）照旧 View Transition。路由器不认识底栏，所以由 App 注入
let tabSwitch: (a: Route, b: Route) => boolean = () => false;

/** App 启动时调一次；测试里可以换 */
export function setTabSwitch(fn: (a: Route, b: Route) => boolean): void {
  tabSwitch = fn;
}

/** 从当前地址去 href：页签互切淡入，别的整页过渡 */
const animTo = (href: string): Anim => (tabSwitch(parseHash(window.location.hash), parseHash(href)) ? 'fade' : 'vt');

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
  noteEntry();
  const now = window.location.hash;
  const skip = uaVisualHash !== null && uaVisualHash === now;
  uaVisualHash = null;
  const old = oldHashOf(e);
  const inPage = old !== null && samePage(parseHash(old), parseHash(now));
  const tab = old !== null && tabSwitch(parseHash(old), parseHash(now));
  void commit(undefined, skip || inPage ? 'none' : tab ? 'fade' : 'vt');
}

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) {
    noteEntry();
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
    noteEntry();
  }, animTo(href));
}

// “这一条历史是从上一层点进来的”（设置的二级页、三级页；提醒接线代码审查 H1、M1）：记在那条历史自己的 history.state 上，
// 浏览器前进后退、刷新、去别的页再回来都跟着那条历史走；页面里点“‹ 返回”时看它决定退一步（goBack）还是原地换成上一层（replaceRoute）。
// 记号的值是压这一条时上一层的地址（复审第二轮 N1）：上一条后来被原地换成了别的页（直接打开的二级页点“‹ 设置”被 replace 成首页，
// 再“前进”回到三层页），goBack 就会跳过一层；所以返回前再对一下上一条现在的地址（entryAt，本标签页这次打开以来记的），对不上就不算
const SUB = 'lemoSub';

// 本标签页这次打开以来，每个深度上现在是哪条地址（N1 用）：压、换、前进后退（hashchange）时都记一笔；刷新以后从空开始，没记到的深度不拿来否定记号
const entryAt = new Map<number, string>();
function noteEntry(): void {
  entryAt.set(depthNow(), window.location.hash);
}

// 快速连点同一个入口（复审 L7）：页面切换包在 View Transition 里，pushState 要等回调才执行，开头的“地址一样就不压”拦不住第二下。
// 还在切的同一个地址直接返回那一次的 Promise；回调里压之前再看一次地址
let subInFlight: { href: string; done: Promise<void> } | null = null;

/** 同 navigate，但在新压的那条历史上记“是从上一层点进来的”（记的是上一层的地址，isSubEntry 读）；设置页的子页入口用 */
export function navigateSub(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  if (subInFlight?.href === href) return subInFlight.done;
  const done = commit(() => {
    if (window.location.hash === href) return;
    noteEntry();
    window.history.pushState({ [DEPTH]: depthNow() + 1, [SUB]: window.location.hash }, '', href);
    noteEntry();
  }, animTo(href)).finally(() => {
    if (subInFlight?.done === done) subInFlight = null;
  });
  subInFlight = { href, done };
  return done;
}

/**
 * 当前这条历史是不是 navigateSub 压进来的、上一条还是当时的上一层：是就该 goBack；
 * 不是（直接打开、被 replace 过、上一条后来被换成了别的页）就原地换成上一层。旧版记号是 true（没记地址），照旧当是
 */
export function isSubEntry(): boolean {
  const st: unknown = window.history.state;
  const mark = typeof st === 'object' && st !== null ? (st as Record<string, unknown>)[SUB] : undefined;
  if (mark === true) return true;
  if (typeof mark !== 'string') return false;
  const before = entryAt.get(depthNow() - 1);
  return before === undefined || before === mark;
}

/**
 * 子页的“‹ 返回”（设置的二级页、三级页）：回到上一层 name/params。
 * • 是点进来的、上一条还是上一层（isSubEntry）：退一步，和侧滑同一条路
 * • 是点进来的，但上一条后来被换成了别的页（N1）：照样退一步（不多压、不叠历史），退到的那一条在 popstate 里（hashchange 之前，
 *   不会先画出那一页）原地换成上一层；那一条不带记号，它的上一条不是它的上一层，再点返回就原地换
 * • 没有记号（直接打开、被 replace 过）：原地换成上一层，不多压一条
 * 记号是地址时一律挂上 popstate 修正（审查 S-L1）：刷新以后 entryAt 是空的，isSubEntry 判不出上一条被换过，
 * 退到的那一条地址对得上时修正什么都不做，对不上就换成上一层，所以中途刷新也不跳层。
 * 修正只认这一次后退（审查 S-L2）：退到的深度必须是退之前减 1；约 1 秒内没派出 popstate 就自己摘掉，不留到之后不相干的后退
 */
export const BACK_FIX_MS = 1000;
export function backOrReplace(name: RouteName, ...params: string[]): void {
  const st: unknown = window.history.state;
  const mark = typeof st === 'object' && st !== null ? (st as Record<string, unknown>)[SUB] : undefined;
  if (mark === true) {
    // 旧版记号（没记地址）：照旧当是点进来的，退一步
    goBack();
    return;
  }
  const href = hrefOf(name, ...params);
  if (typeof mark !== 'string') {
    void replaceRoute(name, ...params);
    return;
  }
  const want = depthNow() - 1;
  const fix = (): void => {
    window.clearTimeout(timer);
    if (depthNow() !== want || window.location.hash === href) return;
    window.history.replaceState({ [DEPTH]: depthNow() }, '', href);
    noteEntry();
  };
  const timer = window.setTimeout(() => window.removeEventListener('popstate', fix), BACK_FIX_MS);
  window.addEventListener('popstate', fix, { once: true });
  goBack();
}

/** 同 navigate，但替换当前这条历史、不新压一条（直接打开的子页点“返回”回上一级时用，免得历史里叠一条子页） */
export function replaceRoute(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState({ [DEPTH]: depthNow() }, '', href);
    noteEntry();
  }, animTo(href));
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
    noteEntry();
  }, 'none');
}

/** 同 navigateInPage，但替换当前这条历史（键盘连按合并、非法参数规整） */
export function replaceInPage(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState({ [DEPTH]: depthNow() }, '', href);
    noteEntry();
  }, 'none');
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
  noteEntry();
}
