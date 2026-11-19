// 四个主页面（今天、日历含翻过月、待办、随手记）从屏幕左右两边往里划切页签。负责人 11-18：
// “在今天，日历，待办，随手记的主页面时左滑，右滑可以互相切换页面”；“之前左滑是回到主页，4个页面切换只在退回到主页面时来回切”（二级页不管）；
// “划到最左（今天）或最右（随手记）就循环”；“切页的触发区域只在左右两边就行”。
// • 只认左右两条切页带（motion 的 sideOf，各 SIDE_PX 宽）里起手的：左边那条往右划去下一个（今天 → 日历 → 待办 → 随手记 → 今天），两头循环；
//   右边那条往左划进设置（负责人 11-19“在今天，日历，待办，随手记主页面右侧滑动默认进入设置页”“左滑切页不变”，原来是去上一个），压一条历史；
//   设置首页左边那条往右划退回来时那一页（负责人 11-19“设置页左滑不返回到桌面”）；系统左边缘返回先退了的判 moved，不再退第二次。
//   负责人 11-18“今天页左滑切到日历，再左滑切到待办，再左滑切到随手记，再左滑切到今天，这样一直循环！”——负责人说的“左滑”是从左边起手往右划
//   （同负责人说的“之前左滑是回到主页”，即 iPhone 左边缘返回；preview.416 日志里负责人的横滑全是 side=l dx>0）；第一版把方向做反了，左边起手去了上一个。
//   列表行左滑、月历翻月在这两条带里起手都不响应（hdrag.ts），所以不会一划两用；中间区域划动一律不切。
// • 也不切：起手在输入框、底栏和“＋”上，弹层和菜单开着，焦点在输入框里（键盘弹着），两根手指，抬手前地址已经变了（系统侧滑返回先走了）。
// • 只听 touch，被动（不 preventDefault、不抓指针、不跟手）：竖着滚照常。抬手时判：往里横移 ≥ SWIPE_MIN_PX、横移 ≥ 竖移 SWIPE_SLOPE 倍、按下到抬手 ≤ SWIPE_MAX_MS。
// • 换页走 navigateTab，和点底栏同一条路（同一个切页动效、同一套历史）；页签互切是原地模糊换页（motion/blur-swap.ts），不分左右，循环那一下也不会反着走。
// 运行日志：tabswipe side= dx= dy= ms= 之后是 to=页签|settings|back 或 skip=原因（只记手势，不记内容）；中间区域起手、横移不到 SWIPE_MIN_PX 的不记
import { TAB_ORDER, type TabName } from '../kit/components/GlassBar/tabs.ts';
import { sideOf } from '../motion/gestures.ts';
import { rlog } from '../platform/run-log-api.ts';
import { canGoBack, goBack, navigate, navigateTab, parseHash, replaceRoute, swapRouteBeforePaint } from './router.ts';

export const SWIPE_MIN_PX = 60;
export const SWIPE_MAX_MS = 500;
/**
 * 横移至少是竖移的几倍才算横滑：原来 2 倍，preview.416 运行日志里负责人从左边往右划，被判太斜（skip=shape）的
 * dx=103 dy=60、120/62、92/50、78/40、118/60、85/44、74/37、106/59，比例都在 1.69～1.80；放到 1.25 倍这些都算数
 */
export const SWIPE_SLOPE = 1.25;

/** 四个主页面各是哪个页签；日历翻过月（#/cal/month/…）还是日历主页面。纪念日、隐私记这些归页签的二级页不算 */
const MAIN: Record<string, TabName> = { today: 'today', calendar: 'calendar', cal: 'calendar', todos: 'todos', notes: 'notes' };
export const mainTab = (route: string): TabName | null => MAIN[route] ?? null;

/**
 * 这一下划完该去哪个页签（纯函数）：side 是起手的那条带。左边那条只认往右划（去下一个），右边那条只认往左划（去上一个），两头循环；
 * 不在四个主页面、方向不对、太短、太斜、太慢都回 null
 */
export function swipeTarget(route: string, side: 'l' | 'r', dx: number, dy: number, ms: number): SwipeMove | null {
  if ((side === 'r' ? -dx : dx) < SWIPE_MIN_PX || Math.abs(dx) < SWIPE_SLOPE * Math.abs(dy) || ms > SWIPE_MAX_MS) return null;
  // 设置首页（不含 #/settings/… 子页）：左边那条往右划退回进来之前那一页
  if (route === 'settings') return side === 'l' ? 'back' : null;
  const tab = mainTab(route);
  if (tab === null) return null;
  // 负责人 11-19“在今天，日历，待办，随手记主页面右侧滑动默认进入设置页”“左滑切页不变”
  if (side === 'r') return 'settings';
  return TAB_ORDER[(TAB_ORDER.indexOf(tab) + 1) % TAB_ORDER.length] ?? null;
}

/** 划完做什么：去哪个页签、进设置（压一条历史）、退回（设置页左边往右划） */
export type SwipeMove = TabName | 'settings' | 'back';

const INPUT = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const BAR = '[data-testid="tabbar"]';
const LAYER = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"]';

/** 起手在切页带里、但这里不切的原因；能切返回 null */
export function blockedAt(target: Element | null, doc: Document = document): string | null {
  if (target === null) return 'none';
  if (target.closest(INPUT)) return 'input';
  if (target.closest(BAR)) return 'tabbar';
  if (doc.querySelector(LAYER)) return 'layer';
  const a = doc.activeElement;
  if (a instanceof Element && a.matches(INPUT)) return 'kb';
  return null;
}

let installed = false;
/** App 用：整个页面只挂一次（开发模式 effect 跑两遍、App 重挂都不会挂成两份，免得一划切两页） */
export function installTabSwipeOnce(): void {
  if (installed) return;
  installed = true;
  installTabSwipe();
}

/** 右边那条按下以后多久之内来的“前进”算是被系统手势抢走的 */
const FWD_MS = 3000;

/** 挂到 document 上；返回取消（测试用） */
export function installTabSwipe(doc: Document = document): () => void {
  const win = doc.defaultView;
  // st：按下时那一条历史的 state 对象。打字条垫的那一条和原页同一个地址，系统侧滑退掉它时 hash 不变，只有 state 对象换了（独立评审 11-19 高 2）
  let s: { side: 'l' | 'r'; x: number; y: number; t: number; hash: string; st: unknown; why: string | null } | null = null;
  const down = (e: TouchEvent): void => {
    const p = e.touches[0];
    const side = p ? sideOf(p.clientX, win?.innerWidth ?? 0) : null;
    if (e.touches.length !== 1 || !p || side === null) {
      s = null;
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    cancelled = false;
    s = { side, x: p.clientX, y: p.clientY, t: performance.now(), hash: win?.location.hash ?? '', st: win?.history.state, why: blockedAt(target, doc) };
  };
  const up = (e: TouchEvent): void => {
    const d = s;
    s = null;
    const p = e.changedTouches[0];
    if (!d || !p || e.touches.length !== 0) return;
    const dx = p.clientX - d.x;
    if (Math.abs(dx) < SWIPE_MIN_PX) return;
    const dy = p.clientY - d.y;
    const ms = Math.round(performance.now() - d.t);
    const hash = win?.location.hash ?? '';
    // 被系统“前进”抢走、抬手照样送来（地址已变）：同 popstate 那条路（见 onPop）
    if (d.side === 'r' && hash !== d.hash && fwdTaken(d, 'up')) return;
    const r = parseHash(hash);
    const route = r.name === 'settings' && r.params.length > 0 ? 'settings-sub' : r.name;
    const why = d.why ?? (hash !== d.hash || win?.history.state !== d.st ? 'moved' : mainTab(route) === null && route !== 'settings' ? 'route' : null);
    const to = why === null ? swipeTarget(route, d.side, dx, dy, ms) : null;
    rlog(`tabswipe side=${d.side} dx=${Math.round(dx)} dy=${Math.round(dy)} ms=${ms} ${to !== null ? `to=${to}` : `skip=${why ?? 'shape'}`}`);
    if (to === null) return;
    // 进设置压一条历史（系统左边缘返回、设置页左边往右划都退得回来时那一页）；退回：这次载入里有上一页才退，否则原地换回今天（不退出 App）
    if (to === 'settings') void navigate('settings');
    else if (to === 'back') {
      if (canGoBack()) goBack();
      else void replaceRoute('today');
    } else navigateTab(to);
  };
  // 负责人 11-19“在待办页点击某个待办，左滑退出以后回到待办页面再右滑的话不进入设置，而是回到之前的某的待办”（又 11-19 下午：修完还是进待办编辑）：
  // 从详情页侧滑退回来以后历史里还留着“前进”那一条，iPhone 右边缘往左划是系统的“前进”手势，会把页面带回那条待办。
  // iPhone 把这一下交给网页有两种：抬手照送（地址已变），或者直接 touchcancel、根本没有抬手（第一版 843cd4f1 只管了前一种，所以没修好）。
  // 所以不靠抬手：主页面右边那条按下以后 3 秒内来了一次 popstate、地址变了，就是被“前进”抢走的——
  // 系统带回来的就是设置首页（之前从设置退回来过）：照收，什么都不做；带回别的页（那条待办）：把这一条原地换成设置。
  // （负责人 11-19 傍晚“设置页自动闪退”：前一版先退回、等下一次 popstate 再压设置，前进那条本来就是设置时也退回去，设置一闪就没了；
  //   两步跳转中间还会闪一下那条待办。改成只换一次，不退回、不再等 popstate。）日志记 how=up|pop、cancel=0|1、at=1（本来就是设置）
  let cancelled = false;
  const fwdTaken = (d: NonNullable<typeof s>, how: 'up' | 'pop'): boolean => {
    if (d.why !== null || d.side !== 'r' || mainTab(parseHash(d.hash).name) === null) return false;
    s = null;
    const now = parseHash(win?.location.hash ?? '');
    const at = now.name === 'settings' && now.params.length === 0;
    rlog(`tabswipe side=r to=settings fwd=1 how=${how} cancel=${cancelled ? 1 : 0} at=${at ? 1 : 0} ms=${Math.round(performance.now() - d.t)}`);
    if (at) return true;
    // popstate 这条路：这个监听挂在捕获阶段，比路由早；路由要等紧跟着的 hashchange 才画页面。在这一刻同步把地址换成设置，
    // 路由读到的已经是设置，直接画设置——那条待办一帧都不画、也不再起一次换页淡入淡出
    // （负责人 11-19 晚录屏：前进带回待办编辑页先停约 0.4 秒、变暗再出设置。系统前进手势自己滑进来那约 0.1 秒是系统存的旧截图，网页管不到）
    if (how === 'pop') swapRouteBeforePaint('settings');
    else void replaceRoute('settings');
    return true;
  };
  const onPop = (): void => {
    const d = s;
    if (!d || performance.now() - d.t > FWD_MS || (win?.location.hash ?? '') === d.hash) return;
    fwdTaken(d, 'pop');
  };
  // 触摸取消：按下那一条留着（系统手势接管时 iPhone 会先取消触摸，popstate 晚一点才来），下一次按下或 3 秒后作废
  const drop = (): void => {
    cancelled = true;
  };
  const o = { passive: true, capture: true } as const;
  doc.addEventListener('touchstart', down, o);
  doc.addEventListener('touchend', up, o);
  doc.addEventListener('touchcancel', drop, o);
  win?.addEventListener('popstate', onPop, true);
  return () => {
    win?.removeEventListener('popstate', onPop, true);
    doc.removeEventListener('touchstart', down, o);
    doc.removeEventListener('touchend', up, o);
    doc.removeEventListener('touchcancel', drop, o);
  };
}
