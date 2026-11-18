// 四个主页面（今天、日历含翻过月、待办、随手记）从屏幕左右两边往里划切页签。负责人 11-18：
// “在今天，日历，待办，随手记的主页面时左滑，右滑可以互相切换页面”；“之前左滑是回到主页，4个页面切换只在退回到主页面时来回切”（二级页不管）；
// “划到最左（今天）或最右（随手记）就循环”；“切页的触发区域只在左右两边就行”。
// • 只认左右两条切页带（motion 的 sideOf，各 SIDE_PX 宽）里起手的：右边那条往左划去底栏右边那个页签，左边那条往右划去左边那个；两头循环。
//   列表行左滑、月历翻月在这两条带里起手都不响应（hdrag.ts），所以不会一划两用；中间区域划动一律不切。
// • 也不切：起手在输入框、底栏和“＋”上，弹层和菜单开着，焦点在输入框里（键盘弹着），两根手指，抬手前地址已经变了（系统侧滑返回先走了）。
// • 只听 touch，被动（不 preventDefault、不抓指针、不跟手）：竖着滚照常。抬手时判：往里横移 ≥ SWIPE_MIN_PX、横移 ≥ 竖移 2 倍、按下到抬手 ≤ SWIPE_MAX_MS。
// • 换页走 navigateTab，和点底栏同一条路（同一个切页动效、同一套历史）；页签互切是原地模糊换页（motion/blur-swap.ts），不分左右，循环那一下也不会反着走。
// 运行日志：tabswipe side= dx= dy= ms= 之后是 to=页签 或 skip=原因（只记手势，不记内容）；中间区域起手、横移不到 SWIPE_MIN_PX 的不记
import { TAB_ORDER, type TabName } from '../kit/components/GlassBar/tabs.ts';
import { sideOf } from '../motion/gestures.ts';
import { rlog } from '../platform/run-log-api.ts';
import { navigateTab, parseHash } from './router.ts';

export const SWIPE_MIN_PX = 60;
export const SWIPE_MAX_MS = 500;

/** 四个主页面各是哪个页签；日历翻过月（#/cal/month/…）还是日历主页面。纪念日、隐私记这些归页签的二级页不算 */
const MAIN: Record<string, TabName> = { today: 'today', calendar: 'calendar', cal: 'calendar', todos: 'todos', notes: 'notes' };
export const mainTab = (route: string): TabName | null => MAIN[route] ?? null;

/**
 * 这一下划完该去哪个页签（纯函数）：side 是起手的那条带。右边那条只认往左划（去下一个），左边那条只认往右划（去上一个），两头循环；
 * 不在四个主页面、方向不对、太短、太斜、太慢都回 null
 */
export function swipeTarget(route: string, side: 'l' | 'r', dx: number, dy: number, ms: number): TabName | null {
  const tab = mainTab(route);
  if (tab === null) return null;
  if ((side === 'r' ? -dx : dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy) || ms > SWIPE_MAX_MS) return null;
  const n = TAB_ORDER.length;
  return TAB_ORDER[(TAB_ORDER.indexOf(tab) + (side === 'r' ? 1 : -1) + n) % n] ?? null;
}

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

/** 挂到 document 上；返回取消（测试用） */
export function installTabSwipe(doc: Document = document): () => void {
  const win = doc.defaultView;
  let s: { side: 'l' | 'r'; x: number; y: number; t: number; hash: string; why: string | null } | null = null;
  const down = (e: TouchEvent): void => {
    const p = e.touches[0];
    const side = p ? sideOf(p.clientX, win?.innerWidth ?? 0) : null;
    if (e.touches.length !== 1 || !p || side === null) {
      s = null;
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    s = { side, x: p.clientX, y: p.clientY, t: performance.now(), hash: win?.location.hash ?? '', why: blockedAt(target, doc) };
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
    const route = parseHash(hash).name;
    const why = d.why ?? (hash !== d.hash ? 'moved' : mainTab(route) === null ? 'route' : null);
    const to = why === null ? swipeTarget(route, d.side, dx, dy, ms) : null;
    rlog(`tabswipe side=${d.side} dx=${Math.round(dx)} dy=${Math.round(dy)} ms=${ms} ${to !== null ? `to=${to}` : `skip=${why ?? 'shape'}`}`);
    if (to === null) return;
    navigateTab(to);
  };
  const drop = (): void => {
    s = null;
  };
  const o = { passive: true, capture: true } as const;
  doc.addEventListener('touchstart', down, o);
  doc.addEventListener('touchend', up, o);
  doc.addEventListener('touchcancel', drop, o);
  return () => {
    doc.removeEventListener('touchstart', down, o);
    doc.removeEventListener('touchend', up, o);
    doc.removeEventListener('touchcancel', drop, o);
  };
}
