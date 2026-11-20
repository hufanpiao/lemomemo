// 屏幕左右两条切页带（motion 的 sideOf，各 SIDE_PX 宽）里起手的横划。负责人 11-18：
// “在今天，日历，待办，随手记的主页面时左滑，右滑可以互相切换页面”；“划到最左（今天）或最右（随手记）就循环”；“切页的触发区域只在左右两边就行”。
// • 四个主页面（今天、日历含翻过月、待办、随手记）：左边那条往右划去下一个（今天 → 日历 → 待办 → 随手记 → 今天），两头循环；
//   右边那条往左划进设置（负责人 11-19“在今天，日历，待办，随手记主页面右侧滑动默认进入设置页”），压进返回栈。
//   负责人说的“左滑”是从左边起手往右划（preview.416 日志里负责人的横滑全是 side=l dx>0）。
//   不切：起手在输入框、底栏和“＋”上，弹层和菜单开着，焦点在输入框里（键盘弹着）。
//   只听 touch，被动（不 preventDefault、不抓指针、不跟手）：竖着滚照常。抬手时判：往里横移 ≥ SWIPE_MIN_PX、横移 ≥ 竖移 SWIPE_SLOPE 倍、按下到抬手 ≤ SWIPE_MAX_MS。
// • 别的页（编辑页、设置、整页提醒……，R-487）：左边那条往右划是 App 自己的返回——返回栈里有上一页就退一步，
//   没有（直接打开）回父级（parentOf）。浏览器历史只有一条（router.ts），iPhone 系统的左边缘返回没东西可退，这一下交给网页。
//   可以从输入框上起手、焦点在输入框里也算（编辑页几乎总有焦点），不限时长；仍要横移 ≥ SWIPE_MIN_PX、够横；弹层开着不响应。
// • 列表行左滑、月历翻月在这两条带里起手都不响应（hdrag.ts），所以不会一划两用；中间区域划动一律不管。
// 运行日志：tabswipe side= dx= dy= ms= 之后是 to=页签|settings|back|up:父级 或 skip=原因（只记手势，不记内容）；中间区域起手、横移不到 SWIPE_MIN_PX 的不记
import { TAB_ORDER } from '../kit/components/GlassBar/tabs.ts';
import { sideOf } from '../motion/gestures.ts';
import { rlog } from '../platform/run-log-api.ts';
import { canGoBack, goBack, LEVELS, mainTabOf, navigate, navigateTab, parseHash, upTo, type Route, type RouteName, type TabName } from './router.ts';

// 页面顶部固定（R-488）和横划切页同是整页的触摸手势、同一时机装：App.tsx 从这一块一起拿，首屏 main 里少一个 import()（11-20 首屏预算）
export { installTopLock } from '../platform/top-lock.ts';

export const SWIPE_MIN_PX = 60;
export const SWIPE_MAX_MS = 500;
/**
 * 横移至少是竖移的几倍才算横滑：原来 2 倍，preview.416 运行日志里负责人从左边往右划，被判太斜（skip=shape）的
 * dx=103 dy=60、120/62、92/50、78/40、118/60、85/44、74/37、106/59，比例都在 1.69～1.80；放到 1.25 倍这些都算数
 */
export const SWIPE_SLOPE = 1.25;

// 哪页是主页面（mainTabOf）、别的页回哪一层（parentOf）都照 router.ts 的路由层级表 LEVELS（日历翻过月、纪念日列表也是主页面；纪念日编辑层不是）

/** 主页面上这一下划完做什么：去哪个页签、进设置 */
export type SwipeMove = TabName | 'settings';

/**
 * 主页面上这一下划完该去哪（纯函数）：tab 是这个主页面的页签（mainTabOf），side 是起手的那条带。左边那条只认往右划（去下一个），右边那条只认往左划（进设置）；
 * 方向不对、太短、太斜、太慢都回 null
 */
export function swipeTarget(tab: TabName, side: 'l' | 'r', dx: number, dy: number, ms: number): SwipeMove | null {
  if ((side === 'r' ? -dx : dx) < SWIPE_MIN_PX || Math.abs(dx) < SWIPE_SLOPE * Math.abs(dy) || ms > SWIPE_MAX_MS) return null;
  if (side === 'r') return 'settings';
  return TAB_ORDER[(TAB_ORDER.indexOf(tab) + 1) % TAB_ORDER.length] ?? null;
}

/** 别的页左边那条往右划算不算返回（R-487）：够长、够横，不限时长 */
export const isEdgeBack = (side: 'l' | 'r', dx: number, dy: number): boolean => side === 'l' && dx >= SWIPE_MIN_PX && Math.abs(dx) >= SWIPE_SLOPE * Math.abs(dy);

/** 直接打开（返回栈空）时左边缘往右划回哪一页（LEVELS 的 up）：主页面是根、没有；没写的（最近删除……）不动 */
export function parentOf(r: Route): RouteName | null {
  const up = LEVELS[r.name].up;
  if (up === undefined || mainTabOf(r) !== null) return null;
  return typeof up === 'function' ? up(r.params) : up;
}

const INPUT = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const BAR = '[data-testid="tabbar"]';
const LAYER = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"]';

/** 主页面上起手在切页带里、但这里不切的原因；能切返回 null */
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
  // why：主页面上不切的原因；layer：按下时有弹层（别的页的返回只看它）
  let s: { side: 'l' | 'r'; x: number; y: number; t: number; hash: string; why: string | null; layer: boolean } | null = null;
  const down = (e: TouchEvent): void => {
    const p = e.touches[0];
    const side = p ? sideOf(p.clientX, win?.innerWidth ?? 0) : null;
    if (e.touches.length !== 1 || !p || side === null) {
      s = null;
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    s = { side, x: p.clientX, y: p.clientY, t: performance.now(), hash: win?.location.hash ?? '', why: blockedAt(target, doc), layer: doc.querySelector(LAYER) !== null };
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
    const r = parseHash(hash);
    const log = (what: string): void => rlog(`tabswipe side=${d.side} dx=${Math.round(dx)} dy=${Math.round(dy)} ms=${ms} ${what}`);
    if (hash !== d.hash) return log('skip=moved');
    const main = mainTabOf(r);
    if (main === null) {
      // 别的页：App 自己的返回
      if (d.layer) return log('skip=layer');
      if (!isEdgeBack(d.side, dx, dy)) return log('skip=shape');
      if (canGoBack()) {
        log('to=back');
        goBack();
        return;
      }
      const to = parentOf(r);
      log(to === null ? 'skip=root' : `to=up:${to}`);
      if (to !== null) void upTo(to);
      return;
    }
    const to = d.why === null ? swipeTarget(main, d.side, dx, dy, ms) : null;
    log(to !== null ? `to=${to}` : `skip=${d.why ?? 'shape'}`);
    if (to === 'settings') void navigate('settings');
    else if (to !== null) navigateTab(to);
  };
  const o = { passive: true, capture: true } as const;
  doc.addEventListener('touchstart', down, o);
  doc.addEventListener('touchend', up, o);
  return () => {
    doc.removeEventListener('touchstart', down, o);
    doc.removeEventListener('touchend', up, o);
  };
}
