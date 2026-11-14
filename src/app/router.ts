// 自写的轻量 hash 路由（架构 2.0）：/app/#/today。路由表集中在这里、带类型
// 页面超过约 15 个或要嵌套数据加载时，换成 React Router 的 hash 模式，改动只在这一个文件
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { cancelFade, fadeSwap, transition } from '../motion/index.ts';
import { rlog } from '../platform/run-log-api.ts';

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
// 浏览器的前进 / 后退（hashchange）走同一条路；一次切换只起一个 View Transition（监听器集中在这里）

const listeners = new Set<() => void>();

// 历史的深度标记 lemoDepth（canGoBack 用）：放在 history.state 里，浏览器后退、刷新都还在；键名直接写字面量（首屏额度）
/** 当前这条历史的 state 里某一项（深度、载入编号、子页记号共用） */
export function stateOf(key: string): unknown {
  const st: unknown = window.history.state;
  return typeof st === 'object' && st !== null ? (st as Record<string, unknown>)[key] : undefined;
}
export function depthNow(): number {
  const d = stateOf('lemoDepth');
  return typeof d === 'number' && d > 0 ? d : 0;
}

// 这次载入的编号（canGoBack 用，代码审查 M1）：App 自己压的历史在 state 里写 lemoDoc；原地换的沿用原来那条的。
// iOS 主屏幕版被系统杀掉后恢复、刷新以后，换了一次载入，旧历史上的编号对不上，就不认它前面还有 App 里的上一页；
// 点底栏的 <a href> 浏览器自己压的历史没有编号，也不会替已经丢掉的上一条“作证”
// 编号只用来区分“这次载入”和“以前的载入”，不出本机、不当密钥用，Math.random 够了；不用 randomUUID：只在安全来源有（http 局域网预览没有），
// 还要写后备，首屏多几十字节（首屏额度）
let doc = Math.random();
/** 要写进历史的 state：step 为 1 是新压一条（深度 + 1，记这次载入的编号），0 是原地换（深度不变，编号沿用原来那条的） */
export function stateFor(step: 0 | 1, extra?: Record<string, unknown>): Record<string, unknown> {
  return { lemoDoc: step ? doc : stateOf('lemoDoc'), lemoDepth: depthNow() + step, ...extra };
}

function notifyAll(): void {
  for (const l of [...listeners]) l();
}

/** 切页怎么动：vt 整页 View Transition；fade 四个页签互切，不起 View Transition、新页淡入（motion 的 fadeSwap）；none 直接画 */
export type Anim = 'vt' | 'fade' | 'none';

/** 改地址（可选）并同步把新页面画完；按 anim 包一层动画 */
export function commit(change?: () => void, anim: Anim = 'vt'): Promise<void> {
  const update = (): void => {
    change?.();
    // 运行日志：pushState、replaceState 换页不触发 hashchange，原来只记得到浏览器自己的前进后退（11-14 b5-vault 点返回后空白，日志里看不出去了哪页）。正式包整段摇掉
    if (import.meta.env.MODE !== 'production') rlog(`route ${window.location.hash} anim=${anim}`);
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

// 两个路由是不是同一个页面（App 按登记表的 samePageAs 设，例如 #/calendar 和 #/cal/...）。
// 架构 5.12：页内切换不用 View Transition。浏览器在同一页里前进 / 后退（月历上个月 ↔ 下个月）也直接画，
// 不播 380ms 的整页淡入淡出（代码复审 R2）；路由器本身不认识功能登记表，所以由 App 注入
let samePage: (a: Route, b: Route) => boolean = () => false;

/** App 启动时调一次；测试里可以换 */
export function setSamePage(fn: (a: Route, b: Route) => boolean): void {
  samePage = fn;
}

/**
 * 从 from 换到 to 起哪种过渡：同一页（samePageAs，例如纪念日列表 → 盖在上面的编辑层）不起过渡；页签互切淡入；别的整页过渡。
 * 同一页不起过渡（整块评审第 20 条，原来另有一份 pushInPage）：编辑层自己从底部滑上来，再叠整页淡入淡出是两层动画；
 * 而且编辑层挂上时锁滚动，过渡途中文档从能滚变成不能滚，WebKit 会整页崩（B5 e2e 实测）
 */
function animOf(from: string, to: string): Anim {
  const a = parseHash(from);
  const b = parseHash(to);
  return samePage(a, b) ? 'none' : tabSwitch(a, b) ? 'fade' : 'vt';
}
/** 从当前地址去 href（navigate、replaceRoute、navigateSub 用；浏览器前进后退的 hashchange 走同一个 animOf） */
export const animTo = (href: string): Anim => animOf(window.location.hash, href);

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
  void commit(undefined, skip ? 'none' : old === null ? 'vt' : animOf(old, now));
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
  return goHref(hrefOf(name, ...params));
}

/**
 * 按现成的地址新压一条（navigate 用；整页提醒的地址带 ?due=，不能走 hrefOf，App 里打开整页提醒时直接给它）：
 * 深度 + 1、记这次载入的编号，关掉整页提醒时 canGoBack 为真、退一步回原页（R-372 代码审 M1）。
 * replaceRoute、replaceInPage 不并进来：分开写 gzip 后反而小几个字节（首屏额度）
 */
export function goHref(href: string): Promise<void> {
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.pushState(stateFor(1), '', href);
    noteEntry();
  }, animTo(href));
}


// 本标签页这次打开以来，每个深度上现在是哪条地址（N1 用）：压、换、前进后退（hashchange）时都记一笔；刷新以后从空开始，没记到的深度不拿来否定记号
export const entryAt = new Map<number, string>();
export function noteEntry(): void {
  entryAt.set(depthNow(), window.location.hash);
}

/** 只给测试用：当作重新载入了一次（换编号、清掉 entryAt）。构建期常量挡掉，正式包里是空函数（首屏额度） */
export function resetLoadForTest(): void {
  if (import.meta.env.MODE !== 'test') return;
  doc = Math.random();
  entryAt.clear();
}





/** 同 navigate，但替换当前这条历史、不新压一条（直接打开的子页点“返回”回上一级时用，免得历史里叠一条子页） */
export function replaceRoute(name: RouteName, ...params: string[]): Promise<void> {
  const href = hrefOf(name, ...params);
  if (window.location.hash === href) return Promise.resolve();
  return commit(() => {
    window.history.replaceState(stateFor(0), '', href);
    noteEntry();
  }, animTo(href));
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
 * 不用 history.length（从别的网站跳进来、同一个标签页之前开过别的页面时也大于 1，一后退就离开 App）。
 * 还要这一条是这次载入里 App 自己压的（state.lemoDoc 等于本次编号，代码审查 M1）：iOS 主屏幕版在后台被系统杀掉，回来时只恢复当前这一条
 * 和它的 state（深度 1），前面的历史没了，只看深度会误判，history.back() 退到 App 外的空白页。不用 entryAt 判：它只按深度记，
 * 恢复后点底栏 <a href> 压出的深度 0 那条会替丢掉的上一条“作证”。刷新以后第一次返回也走“原地换”，多留一条历史，不会退出 App
 */
export function canGoBack(): boolean {
  // 编号只有 navigate 类压的历史（深度至少 1）才写、原地换只沿用，所以带这次编号的一定深度 > 0，不用再比深度（首屏额度）
  return stateOf('lemoDoc') === doc;
}

/**
 * 按层级回到 name（R-372，负责人 11-10“往左滑应该是返回上一个层级，不是返回上一个操作”）：上一条是这次载入里记到的、就是 name 那一页，
 * 退一步（和左滑同一条路，不多压）；否则原地换成 name（不压历史；iOS 恢复后、刷新后也不会退出 App）
 */
export function backTo(name: RouteName): void {
  // 已经在 name：replaceRoute 自己会不动；上一条不会也是 name（navigateTab 不在今天上面再叠今天），不用先比地址
  const prev = entryAt.get(depthNow() - 1);
  if (canGoBack() && prev !== undefined && parseHash(prev).name === name) goBack();
  else void replaceRoute(name);
}

/** 链接的普通点击（不是按着修饰键、中键开新标签页）：拦下浏览器默认跳转、回 true，由调用方交给路由；新标签页打开照常、回 false */
export function plainClick(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button' | 'preventDefault'>): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return false;
  e.preventDefault();
  return true;
}

/**
 * 底栏页签（R-372 ①“其他页左滑回今天”）：今天是根。今天 → 别的页签压一条（左滑回今天）；别的页签之间原地换；
 * 回今天按 backTo（上一条就是今天就退一步，否则原地换）。在今天页左滑不动：今天下面不再叠别的页签
 */
export function navigateTab(name: RouteName): void {
  if (name === 'today') backTo(name);
  else void (parseHash(window.location.hash).name === 'today' ? navigate : replaceRoute)(name);
}


