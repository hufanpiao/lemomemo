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
  // 随手记编辑器（B4 S2）：#/note/<id>、#/note/new
  'note',
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
// 别的办法换了地址（hashchange）走同一条路；一次切换只起一个 View Transition（监听器集中在这里）

const listeners = new Set<() => void>();

// ───────── 返回栈（R-487，负责人 11-19“右滑重写”）─────────
// App 从不调 pushState，浏览器历史永远只有一条：iOS 主屏幕版只要历史里留着“前进”那一条，右边缘往左划就被系统抢去播旧截图
// （负责人运行日志 t=7.50 down x=431 → 7.53 pointercancel → 7.60 route #/todo，网页挡不住），所以干脆不给它留。
// 上一页记在这一条历史自己的 history.state.lemoStack 里（地址数组，上一页在最后）：刷新、iOS 恢复后都还在。
// 进页面（goHref）把当前地址压进栈、原地换；返回（goBack）弹出栈顶、原地换回去；到四个主页面（含翻过月的日历）一律清空，主页面是根
const KEY = 'lemoStack';
const ROOTS: ReadonlySet<string> = new Set(['today', 'calendar', 'cal', 'todos', 'notes']);

/** 当前这条历史记的返回栈（上一页在最后）；不是数组、混了别的东西都当没有 */
export function stackOf(): string[] {
  const st: unknown = window.history.state;
  const s = typeof st === 'object' && st !== null ? (st as Record<string, unknown>)[KEY] : undefined;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string' && x.startsWith('#/')) : [];
}

/** 原地写地址和返回栈（App 里换地址的唯一出口；最多记 50 层） */
export function writeEntry(href: string, stack: readonly string[] = stackOf()): void {
  window.history.replaceState({ [KEY]: ROOTS.has(parseHash(href).name) ? [] : stack.slice(-50) }, '', href);
}

function notifyAll(): void {
  for (const l of [...listeners]) l();
}

/**
 * 切页怎么动：vt 整页 View Transition；slide-r / slide-l 四个页签互切，不起 View Transition、按底栏顺序左右滑入
 * （slide-r 往右边的页签走、新页从右边进；motion 的 fadeSwap，负责人 11-18 选 B）；none 直接画
 */
export type Anim = 'vt' | 'slide-r' | 'slide-l' | 'none';

/** 改地址（可选）并同步把新页面画完；按 anim 包一层动画 */
export function commit(change?: () => void, anim: Anim = 'vt'): Promise<void> {
  const update = (): void => {
    change?.();
    flushSync(notifyAll);
  };
  if (anim === 'none') {
    cancelFade(false); // 页签互切的淡入还在等分包：停掉，同页内换上来的不是它要等的页（代码审查方案 B M9）
    update();
    return Promise.resolve();
  }
  if (anim === 'slide-r' || anim === 'slide-l') return fadeSwap(update);
  return transition(update);
}

// 两个路由是不是“四个页签之间互切”、往哪边（App 按 tab-of.ts 设：两头都有底栏、页签不同；1 往右边的页签，-1 往左，0 不是页签互切）。负责人 11-06 选方案 B：
// 页签互切不走 View Transition，底栏、液滴、顶部模糊一直实时模糊（WebKit 过渡期间不画 backdrop-filter，bug 302256）；
// 别的切页（进编辑页、设置……）照旧 View Transition。路由器不认识底栏，所以由 App 注入
let tabSwitch: (a: Route, b: Route) => -1 | 0 | 1 = () => 0;

/** App 启动时调一次；测试里可以换 */
export function setTabSwitch(fn: (a: Route, b: Route) => -1 | 0 | 1): void {
  tabSwitch = fn;
}

// 两个路由是不是同一个页面（App 按登记表的 samePageAs 设，例如 #/calendar 和 #/cal/...）。
// 架构 5.12：页内切换不用 View Transition。同一页里换地址（月历上个月 ↔ 下个月）也直接画，
// 不播 380ms 的整页淡入淡出（代码复审 R2）；路由器本身不认识功能登记表，所以由 App 注入
let samePage: (a: Route, b: Route) => boolean = () => false;

/** App 启动时调一次；测试里可以换 */
export function setSamePage(fn: (a: Route, b: Route) => boolean): void {
  samePage = fn;
}

/**
 * 从 from 换到 to 起哪种过渡：同一页（samePageAs，例如纪念日列表 → 盖在上面的编辑层）不起过渡；页签互切左右滑入；别的整页过渡。
 * 同一页不起过渡（整块评审第 20 条，原来另有一份 pushInPage）：编辑层自己从底部滑上来，再叠整页淡入淡出是两层动画；
 * 而且编辑层挂上时锁滚动，过渡途中文档从能滚变成不能滚，WebKit 会整页崩（B5 e2e 实测）
 */
function animOf(from: string, to: string): Anim {
  const a = parseHash(from);
  const b = parseHash(to);
  if (samePage(a, b)) return 'none';
  const dir = tabSwitch(a, b);
  return dir === 1 ? 'slide-r' : dir === -1 ? 'slide-l' : 'vt';
}
/** 从当前地址去 href（goHref、replaceRoute、goBack 用；别的办法换地址的 hashchange 走同一个 animOf） */
export const animTo = (href: string): Anim => animOf(window.location.hash, href);

/** hashchange 的 oldURL 里的 hash；没有（老浏览器、测试里手工派的事件）时返回 null，照常起动画 */
function oldHashOf(e: Event): string | null {
  const old = (e as HashChangeEvent).oldURL;
  if (typeof old !== 'string' || old === '') return null;
  const i = old.indexOf('#');
  return i < 0 ? '' : old.slice(i);
}

// 浏览器历史前进、后退（popstate）后紧跟的那次 hashchange：iOS 系统边缘手势已经自己播完一张截图滑进来（App 从不压历史，
// 只有更早版本、推送打开留下的旧记录才走到这里）。再起一次整页淡出淡入，画面就是“滑进来 → 旧页闪回 → 变黑 → 再淡入”
// （负责人 11-20 录屏“右滑进设置页会跳一下画面”），所以这一下直接画新页、不再补动画
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
  void commit(undefined, popped ? 'none' : old === null ? 'vt' : animOf(old, window.location.hash));
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
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
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
 * 跳到某个路由；页面切换包在 View Transitions 里（17.2 第 3 点）。
 * 原地换地址、当前地址压进返回栈（不触发 hashchange，不会重复切换），再 flushSync 让 React 在回调里画完新页面。
 * 已经在这一页（地址没变）就直接返回：不起空 transition，免得切换期间约 0.25 秒点按被吞掉（UI-4 第二轮 N-2）
 */
export function navigate(name: RouteName, ...params: string[]): Promise<void> {
  return goHref(hrefOf(name, ...params));
}

/** 按现成的地址进一页（navigate 用；整页提醒的地址带 ?due=，不能走 hrefOf，App 里打开整页提醒时直接给它） */
export function goHref(href: string, anim: Anim = animTo(href)): Promise<void> {
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    // 快速连点同一个入口（复审 L7）：换页包在过渡里、回调晚执行，第二下也会进来；回调里再看一次，已经到了就不再压栈
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

/**
 * 退回返回栈里的上一页（“‹ 返回”、二级页左边缘往右划、设置页左边往右划）：弹出栈顶、原地换回去，和进来时同一套换页动画；栈空什么都不做。
 * 栈在调用的这一刻就读好：过渡回调晚执行，快速连点两下写的是同一个结果，不会退两层
 */
export function goBack(): void {
  const stack = stackOf();
  const prev = stack.pop();
  if (prev !== undefined) void commit(() => writeEntry(prev, stack), animTo(prev));
}

/** 有没有“App 里的上一页”：返回栈不空。直接打开（推送、书签）的页没有，返回时原地换成上一层，不会退出 App */
export function canGoBack(): boolean {
  return stackOf().length > 0;
}

/** 按层级回到 name（R-372，负责人 11-10“往左滑应该是返回上一个层级，不是返回上一个操作”）：栈顶就是 name 那一页就退一步；否则原地换成 name */
export function backTo(name: RouteName): void {
  const s = stackOf();
  const prev = s[s.length - 1];
  if (prev !== undefined && parseHash(prev).name === name) goBack();
  else void replaceRoute(name);
}

/** 链接的普通点击（不是按着修饰键、中键开新标签页）：拦下浏览器默认跳转、回 true，由调用方交给路由；新标签页打开照常、回 false */
export function plainClick(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button' | 'preventDefault'>): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return false;
  e.preventDefault();
  return true;
}

/** 四个主页面（底栏页签）：它们之间互切一律原地换 */
const MAIN_TABS: ReadonlySet<RouteName> = new Set<RouteName>(['today', 'calendar', 'todos', 'notes']);

/**
 * 底栏页签、左右两边横滑切页（app/tab-swipe.ts）：四个主页面之间一律原地换，不压栈（主页面是根，到了就清空栈）。
 * 负责人 11-18 推翻 R-372 ①“其他页左滑回今天”：“之前左滑是回到主页，4个页面切换只在退回到主页面时来回切”。
 * 设置（右上头像）照旧：从今天进压栈，从别的页签进原地换
 */
export function navigateTab(name: RouteName): void {
  if (MAIN_TABS.has(name)) void replaceRoute(name);
  else void (parseHash(window.location.hash).name === 'today' ? navigate : replaceRoute)(name);
}
