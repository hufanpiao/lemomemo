// 自写的轻量 hash 路由：/app/#/today。路由表集中在这里、带类型
// 页面超过约 15 个或要嵌套数据加载时，换成 React Router 的 hash 模式，改动只在这一个文件
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createSignal } from '../../shared/core/signal.ts';
import { cancelFade, fadeSwap, transition } from '../motion/index.ts';

export const ROUTE_NAMES = [
  'today',
  'calendar',
  // 月历、周视图：#/cal/month/<年-月>、#/cal/week/<那周任一天>；底栏的 #/calendar 等于本月
  'cal',
  'todos',
  // 编辑页：#/event/<id>、#/event/new，#/todo/<id>、#/todo/new
  'event',
  'todo',
  // “最近删除”：#/trash
  'trash',
  'notes',
  // 随手记编辑器：#/note/<id>、#/note/new
  'note',
  'vault',
  'anniv',
  // 整页提醒：#/remind/<kind>/<id>?due=<dueAt>。地址只由 openReminder / reminderHash
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

// ───────── 路由层级表 ─────────
// 每个路由一行：显示底栏时归哪个页签、“＋”新建什么；是不是主页面；直接打开时左边缘往右划回哪一层。
// 都从这一张推出来、别处不再另写：清不清返回栈（writeEntry）、底栏（tab-of.ts 的 tabBarFor）、切页过渡（page-anim.ts）、
// 横滑（tab-swipe.ts）。加页面只加一行；Record 要写全，漏一行类型检查就报
/** 底栏四个页签（顺序在 kit 的 GlassBar/tabs.ts） */
export type TabName = 'today' | 'calendar' | 'todos' | 'notes';
export interface Level {
  /** 显示底栏：选中哪个页签、“＋”新建什么；subs：只有路径第一段是这几个时才显示（隐私记的记录页不显示）；hold: false 不能按住“＋”说话 */
  bar?: { tab: TabName; add: 'event' | 'todo' | 'note' | 'anniv'; subs?: readonly string[]; hold?: false };
  /** 主页面（页签的根，要有 bar）：能左右划切页签、右边往左划进设置，到这里清空返回栈。'bare' 只算不带参数的（纪念日列表算，编辑层不算） */
  main?: 'any' | 'bare';
  /** 不是主页面、返回栈空（直接打开）时左边缘往右划回哪一层；不写的不动 */
  up?: RouteName | ((params: readonly string[]) => RouteName);
  /** 网页版宽屏右边常驻 AI 栏：栏里按哪一页说“在看……”。不写时有底栏的页按它的页签算、没底栏的不出；
   *  null 不出栏（页面外框也不让出右边）。main 是 'bare' 的只算不带参数的 */
  dock?: DockPage | null;
}
/** 常驻 AI 栏认的几页（ai-chat 的 ChatDock 按它换“在看……”和建议问题） */
export type DockPage = 'today' | 'calendar' | 'todos' | 'notes' | 'anniv' | 'settings';
export const LEVELS: Record<RouteName, Level> = {
  today: { bar: { tab: 'today', add: 'event' }, main: 'any' },
  calendar: { bar: { tab: 'calendar', add: 'event' }, main: 'any' },
  cal: { bar: { tab: 'calendar', add: 'event' }, main: 'any' },
  todos: { bar: { tab: 'todos', add: 'todo' }, main: 'any' },
  notes: { bar: { tab: 'notes', add: 'note' }, main: 'any' },
  // 纪念日：列表是日历页签的主页面，编辑层 #/anniv/<id> 栈空回列表（编辑层整屏盖在列表上，不出常驻栏）
  anniv: { bar: { tab: 'calendar', add: 'anniv', hold: false }, main: 'bare', up: 'anniv', dock: 'anniv' },
  // 隐私记不出常驻栏（私密的记录不放在 AI 助手旁边）
  // 隐私记归随手记页签；记录页 #/vault/new、#/vault/<id> 不显示底栏；按住不录音（录下的会进普通随手记）
  vault: { bar: { tab: 'notes', add: 'note', subs: ['', 'c', 'trash'], hold: false }, up: 'notes', dock: null },
  todo: { up: 'todos' },
  // 跟日程编辑页“‹ 返回”一致（EventEditPage 的 backOr('today')）
  event: { up: 'today' },
  note: { up: 'notes' },
  remind: { up: 'today' },
  // 设置子页回设置首页，设置首页回今天；宽屏设置、最近删除右边也是 AI 栏（App 的 TabBar 据 dock 画不亮页签的侧栏）
  settings: { up: (p) => (p.length > 0 ? 'settings' : 'today'), dock: 'settings' },
  // 最近删除直接打开回设置（跟同页“‹ 返回”的 backOr('settings') 一致）
  trash: { up: 'settings', dock: 'settings' },
  onboarding: {},
  'dev-csp': {},
};

/** 这一页的底栏那一行（LEVELS 的 bar；sub 是路径里名字后面第一段，bar.subs 写了就只有这几个子页有）；没有回 null。tab-of.ts 的 tabBarFor、page-anim.ts 都照它 */
export function levelBar(name: RouteName, sub = ''): NonNullable<Level['bar']> | null {
  const b = LEVELS[name].bar;
  return b && (!b.subs || b.subs.includes(sub)) ? b : null;
}

/** 这一页是哪个页签的主页面（能左右划切页签、右边往左划进设置、到这里清空返回栈）；不是主页面回 null */
export function mainTabOf(r: Route): TabName | null {
  const l = LEVELS[r.name];
  return l.main === 'any' || (l.main === 'bare' && r.params.length === 0) ? (l.bar?.tab ?? null) : null;
}

// 认路由名照 LEVELS 的键（类型上和 ROUTE_NAMES 一一对上）：ROUTE_NAMES 运行时没人用，不进首屏 main
const isRouteName = (s: string): s is RouteName => Object.hasOwn(LEVELS, s);

/** '#/notes/abc' → {name: 'notes', params: ['abc']}；认不出来的回今天页 */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head = '', ...rest] = path.split('/').filter((x) => x !== '');
  if (!isRouteName(head)) return DEFAULT_ROUTE;
  return { name: head, params: rest.map((x) => decodeURIComponent(x)) };
}

/** 路由 → href（JSX 里的 href 只能是常量、hrefOf() 或 safeHref() 的返回值） */
export function hrefOf(name: RouteName, ...params: string[]): string {
  const tail = params.map((p) => `/${encodeURIComponent(p)}`).join('');
  return `#/${name}${tail}`;
}

// ───────── 路由状态和页面切换 ─────────
// React 读的是 location.hash，但只在我们通知时才重画：页面切换包在 motion 的换页动画里，
// 回调里同步改地址并 flushSync 通知，回调一返回新页面就已经画完。
// hashchange 走同一条路；一次切换只起一次换页动画（监听器集中在这里）

const listeners = createSignal();

// ───────── 返回栈 ─────────
// App 从不调 pushState，浏览器历史永远只有一条：iOS 主屏幕版只要历史里留着“前进”，右边缘往左划就被系统抢去播旧截图，网页挡不住。
// 上一页记在这一条历史自己的 history.state.lemoStack 里（地址数组，上一页在最后）：刷新、iOS 恢复后都还在。
// 进页面（goHref）压栈、原地换；返回（goBack）弹栈、原地换回去；到主页面（LEVELS 的 main）一律清空
const KEY = 'lemoStack';

/** 当前这条历史记的返回栈（上一页在最后）；不是数组、混了别的东西都当没有 */
export function stackOf(): string[] {
  const st: unknown = window.history.state;
  const s = typeof st === 'object' && st !== null ? (st as Record<string, unknown>)[KEY] : undefined;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string' && x.startsWith('#/')) : [];
}

/** 原地写地址和返回栈（App 里换地址的唯一出口；最多记 50 层） */
export function writeEntry(href: string, stack: readonly string[] = stackOf()): void {
  window.history.replaceState({ [KEY]: mainTabOf(parseHash(href)) ? [] : stack.slice(-50) }, '', href);
}

const notifyAll = listeners.emit;

/**
 * 切页怎么动：push 整页推页（新页从右滑进）；pop 返回方向（旧页往右滑出），两种都是 motion 的 transition（不用 View Transition）；
 * fade 四个页签互切（motion 的 fadeSwap，原地模糊淡换）；part 同一页里只把详情那一栏（data-swap-part）原地模糊淡换
 * （网页版宽屏设置里换层）；none 直接画
 */
export type Anim = 'push' | 'pop' | 'fade' | 'part' | 'none';

/** 改地址（可选）并同步把新页面画完；按 anim 包一层动画 */
export function commit(change?: () => void, anim: Anim = 'push'): Promise<void> {
  const update = (): void => {
    change?.();
    flushSync(notifyAll);
  };
  if (anim === 'none') {
    cancelFade(false); // 页签互切的淡入还在等分包：停掉，换上来的不是它要等的页
    update();
    return Promise.resolve();
  }
  if (anim === 'push' || anim === 'pop') return transition(update, anim === 'pop');
  return fadeSwap(update, anim === 'part');
}

// 两个路由之间起哪种过渡：规则在 app/page-anim.ts，路由器不认识底栏和功能登记表，所以由 App 注入。
// 规则首屏画完以后才下载；注入以前一律直接画（换页动画的实现也是画完才下载）
let animFor: (a: Route, b: Route) => Anim = () => 'none';

/** App 首屏画完以后调一次；测试里可以换 */
export function setAnimOf(fn: (a: Route, b: Route) => Anim): void {
  animFor = fn;
}

const animOf = (from: string, to: string): Anim => animFor(parseHash(from), parseHash(to));
/** 从当前地址去 href（goHref、replaceRoute、goBack 用；别的办法换地址的 hashchange 走同一个 animOf） */
export const animTo = (href: string): Anim => animOf(window.location.hash, href);
/** 返回方向：整页过渡换成往回滑（页签互切、同页不变） */
const backAnim = (a: Anim): Anim => (a === 'push' ? 'pop' : a);

/** hashchange 的 oldURL 里的 hash；没有（老浏览器、测试里手工派的事件）时返回 null，照常起动画 */
function oldHashOf(e: Event): string | null {
  const old = (e as HashChangeEvent).oldURL;
  if (typeof old !== 'string' || old === '') return null;
  const i = old.indexOf('#');
  return i < 0 ? '' : old.slice(i);
}

// popstate 后紧跟的那次 hashchange：iOS 系统边缘手势已经自己播完一张截图滑进来（只有更早版本、推送打开留下的旧记录才走到这里）。
// 再起一次整页过渡画面会跳一下，所以这一下直接画新页、不再补动画
const POP_MS = 500;
let poppedAt = -Infinity;
function onPopState(): void {
  // 只在手机上（没有悬停的设备：iOS、安卓边缘手势自己播动画）；电脑浏览器点后退没有系统动画，照旧起整页过渡
  if (window.matchMedia?.('(hover: none)').matches) poppedAt = performance.now();
}

function onHashChange(e: Event): void {
  const old = oldHashOf(e);
  const popped = performance.now() - poppedAt < POP_MS;
  poppedAt = -Infinity;
  void commit(undefined, popped ? 'none' : old === null ? 'push' : animOf(old, window.location.hash));
}

/** 全局兜底：没人接手的 <a href="#/…"> 普通点击，浏览器默认会压一条历史（又留出“前进”），拦下交给 goHref；新标签页打开照常 */
function onLinkClick(e: MouseEvent): void {
  if (e.defaultPrevented) return;
  const a = e.target instanceof Element ? e.target.closest('a[href^="#/"]') : null;
  if (!a || a.hasAttribute('target') || a.hasAttribute('download') || !plainClick(e)) return;
  void goHref(a.getAttribute('href') ?? '');
}

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('click', onLinkClick);
  }
  const off = listeners.subscribe(cb);
  return () => {
    off();
    if (listeners.size === 0) {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('click', onLinkClick);
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
 * 跳到某个路由；页面切换包在换页动画里。
 * 原地换地址、当前地址压进返回栈（不触发 hashchange，不会重复切换），再 flushSync 让 React 在回调里画完新页面。
 * 已经在这一页就直接返回：不起空 transition
 */
export function navigate(name: RouteName, ...params: string[]): Promise<void> {
  return goHref(hrefOf(name, ...params));
}

/** 按现成的地址进一页（navigate 用；整页提醒的地址带 ?due=，不能走 hrefOf，App 里打开整页提醒时直接给它） */
export function goHref(href: string, anim: Anim = animTo(href)): Promise<void> {
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    // 快速连点同一个入口：回调晚执行，第二下也会进来；回调里再看一次，已经到了就不再压栈
    const now = window.location.hash;
    if (now !== href) writeEntry(href, [...stackOf(), now]);
  }, anim);
}

/** 同 navigate，但不把当前这页压进返回栈（直接打开的子页点“返回”回上一级、页签互切） */
export function replaceRoute(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => writeEntry(href), animTo(href));
}

/** 同 replaceRoute，但按“回上一层”的方向滑（直接打开的子页点返回、左边缘往右划回父级：没有返回栈，原地换成上一层） */
export function upTo(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => writeEntry(href), backAnim(animTo(href)));
}

/**
 * 退回返回栈里的上一页（“‹ 返回”、二级页左边缘往右划、设置页左边往右划）：弹出栈顶、原地换回去，和进来时同一套换页动画；栈空什么都不做。
 * 栈在调用的这一刻就读好：过渡回调晚执行，快速连点两下写的是同一个结果，不会退两层
 */
export function goBack(): void {
  const stack = stackOf();
  const prev = stack.pop();
  if (prev !== undefined) void commit(() => writeEntry(prev, stack), backAnim(animTo(prev)));
}

/** 有没有“App 里的上一页”：返回栈不空。直接打开（推送、书签）的页没有，返回时原地换成上一层，不会退出 App */
export function canGoBack(): boolean {
  return stackOf().length > 0;
}

/** 按层级（不是按上一个操作）回到 name：栈顶就是 name 那一页就退一步；否则原地换成 name */
export function backTo(name: RouteName): void {
  const s = stackOf();
  const prev = s[s.length - 1];
  if (prev !== undefined && parseHash(prev).name === name) goBack();
  else void upTo(name);
}

/** 链接的普通点击（不是按着修饰键、中键开新标签页）：拦下浏览器默认跳转、回 true，由调用方交给路由；新标签页打开照常、回 false */
export function plainClick(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button' | 'preventDefault'>): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return false;
  e.preventDefault();
  return true;
}

/**
 * 底栏页签、左右两边横滑切页（app/tab-swipe.ts）：四个主页面之间一律原地换，不压栈（主页面是根）。
 * 设置（右上头像）：从今天进压栈，从别的页签进原地换
 */
export function navigateTab(name: TabName | 'settings'): void {
  if (name !== 'settings') void replaceRoute(name);
  else void (parseHash(window.location.hash).name === 'today' ? navigate : replaceRoute)(name);
}
