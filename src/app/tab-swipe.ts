// 屏幕左右两条切页带（motion 的 sideOf，各 SIDE_PX 宽）里起手的横划；中间区域划动一律不管。“左滑”指从左边起手往右划。
// • 四个主页面（今天、日历含翻过月、待办、随手记）：左边那条往右划去下一个页签，两头循环；右边那条往左划进设置，压进返回栈。
//   不切：起手在输入框、底栏和“＋”上，弹层和菜单开着，焦点在输入框里（键盘弹着）。
//   只听 touch，被动（不 preventDefault、不抓指针、不跟手）：竖着滚照常。抬手时判：头一段是横的、往里横移 ≥ SWIPE_MIN_PX、≤ SWIPE_MAX_MS。
// • 别的页：左边那条往右划是 App 自己的返回，直接调 BackLink 登记的 onBack（kit/hooks/back-action.ts），先让焦点离开输入框把字交上去。
//   没有返回按钮的页才自己走：返回栈有上一页就退一步，没有回父级（parentOf）。
//   浏览器历史只有一条（router.ts），iPhone 系统的左边缘返回没东西可退，这一下交给网页。
//   输入框上起手、焦点在输入框里也算，不限时长；仍要横移 ≥ SWIPE_MIN_PX、够横；弹层开着不响应（data-route-page 的页面层不算弹层，见 LAYER）。
// • 列表行左滑、月历翻月在这两条带里起手都不响应（hdrag.ts），不会一划两用。
// 运行日志：tabswipe side= dx= dy= ms= 后接 to=页签|settings|btn|back|up:父级 或 skip=原因（只记手势，不记内容）；横移不到 SWIPE_MIN_PX 的不记
import { TAB_ORDER } from '../kit/components/GlassBar/tabs.ts';
import { lockOf, sideOf, type Axis } from '../motion/gestures.ts';
import { currentBack } from '../kit/hooks/back-action.ts';
import { rlog } from '../platform/run-log-api.ts';
import { canGoBack, goBack, LEVELS, mainTabOf, navigate, navigateTab, parseHash, upTo, type Route, type RouteName, type TabName } from './router.ts';

// 顶部固定、切页过渡规则、视口监听和拦缩放同样首屏画完才要：放在这一块让 App 一次装齐，首屏 main 里少几个 import()
import type { FeatureRoute } from './features.ts';
import { installPageAnim } from './page-anim.ts';
import { installTopLock } from '../platform/top-lock.ts';
import { blockPageZoom, startViewport } from '../platform/viewport.ts';

/** App 首屏画完以后调一次：横划切页、顶部固定、切页过渡规则、视口监听和拦缩放；返回卸掉视口两样（App 卸载时调） */
export function installAfterPaint(routes: readonly FeatureRoute[]): () => void {
  installTabSwipeOnce();
  installTopLock();
  installPageAnim(routes);
  const k = startViewport();
  const z = blockPageZoom();
  return () => {
    k();
    z();
  };
}

export const SWIPE_MIN_PX = 60;
export const SWIPE_MAX_MS = 500;
/*
 * 横还是竖：看手指头一段往哪走（lockOf，和月历翻页、列表行左滑同一套），不看抬手时终点的斜率：
 * 拇指先横着走、后半段弯向右下，按终点斜率会被判太斜；竖着滚头一段就是竖的，照样不切
 */

// 哪页是主页面（mainTabOf）、别的页回哪一层（parentOf）都照 router.ts 的路由层级表 LEVELS

/** 主页面上这一下划完做什么：去哪个页签、进设置 */
export type SwipeMove = TabName | 'settings';

/** 主页面上这一下划完该去哪（纯函数）：左边那条只认往右划、右边那条只认往左划；方向不对、太短、太斜、太慢回 null */
export function swipeTarget(tab: TabName, side: 'l' | 'r', dx: number, axis: Axis, ms: number): SwipeMove | null {
  if (axis !== 'h' || (side === 'r' ? -dx : dx) < SWIPE_MIN_PX || ms > SWIPE_MAX_MS) return null;
  if (side === 'r') return 'settings';
  return TAB_ORDER[(TAB_ORDER.indexOf(tab) + 1) % TAB_ORDER.length] ?? null;
}

/** 别的页左边那条往右划算不算返回：头一段是横的、够长，不限时长 */
export const isEdgeBack = (side: 'l' | 'r', dx: number, axis: Axis): boolean => side === 'l' && axis === 'h' && dx >= SWIPE_MIN_PX;

/** 直接打开（返回栈空）时左边缘往右划回哪一页（LEVELS 的 up）：主页面是根、没有；没写的（最近删除……）不动 */
export function parentOf(r: Route): RouteName | null {
  const up = LEVELS[r.name].up;
  if (up === undefined || mainTabOf(r) !== null) return null;
  return typeof up === 'function' ? up(r.params) : up;
}

const INPUT = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const BAR = '[data-testid="tabbar"]';
/**
 * 页面本身就是一层的（纪念日编辑页是 Radix 模态对话框）：根上标 data-route-page，不算“弹层开着”，否则这一页自己就拦住了返回。
 * 它上面再叠的弹层、删除确认照样拦
 */
const LAYER = ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[role="menu"]'].map((s) => `${s}:not([data-route-page])`).join(',');

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
  // why：主页面上不切的原因；layer：按下时有弹层（别的页的返回只看它）；axis：头一段定下的方向，lock：定下那一刻的位移（日志用）
  let s: { side: 'l' | 'r'; x: number; y: number; t: number; hash: string; why: string | null; layer: boolean; axis: Axis; lock: string } | null = null;
  const down = (e: TouchEvent): void => {
    const p = e.touches[0];
    const side = p ? sideOf(p.clientX, win?.innerWidth ?? 0) : null;
    if (e.touches.length !== 1 || !p || side === null) {
      s = null;
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    s = { side, x: p.clientX, y: p.clientY, t: performance.now(), hash: win?.location.hash ?? '', why: blockedAt(target, doc), layer: doc.querySelector(LAYER) !== null, axis: 'none', lock: '' };
  };
  /** 头一段：走过 TAP_SLOP_PX 定下横竖，之后不再算 */
  const settle = (d: NonNullable<typeof s>, x: number, y: number): void => {
    if (d.axis !== 'none') return;
    d.axis = lockOf(x - d.x, y - d.y);
    if (d.axis !== 'none') d.lock = `@${Math.round(x - d.x)},${Math.round(y - d.y)}`;
  };
  const move = (e: TouchEvent): void => {
    const p = e.touches[0];
    if (s && p && e.touches.length === 1) settle(s, p.clientX, p.clientY);
  };
  const up = (e: TouchEvent): void => {
    const d = s;
    s = null;
    const p = e.changedTouches[0];
    if (!d || !p || e.touches.length !== 0) return;
    const dx = p.clientX - d.x;
    if (Math.abs(dx) < SWIPE_MIN_PX) return;
    // 一下快划、中间没来 touchmove：按全程定
    settle(d, p.clientX, p.clientY);
    const dy = p.clientY - d.y;
    const ms = Math.round(performance.now() - d.t);
    const hash = win?.location.hash ?? '';
    const r = parseHash(hash);
    const log = (what: string): void => rlog(`tabswipe side=${d.side} dx=${Math.round(dx)} dy=${Math.round(dy)} ms=${ms} ax=${d.axis}${d.lock} ${what}`);
    if (hash !== d.hash) return log('skip=moved');
    const main = mainTabOf(r);
    if (main === null) {
      // 别的页：App 自己的返回
      if (d.layer) return log('skip=layer');
      if (!isEdgeBack(d.side, dx, d.axis)) return log('skip=shape');
      const btn = currentBack();
      if (btn !== null) {
        if (btn.off()) return log('skip=off');
        log('to=btn');
        (doc.activeElement as HTMLElement | null)?.blur?.();
        btn.run();
        return;
      }
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
    const to = d.why === null ? swipeTarget(main, d.side, dx, d.axis, ms) : null;
    log(to !== null ? `to=${to}` : `skip=${d.why ?? 'shape'}`);
    if (to === 'settings') void navigate('settings');
    else if (to !== null) navigateTab(to);
  };
  const o = { passive: true, capture: true } as const;
  doc.addEventListener('touchstart', down, o);
  doc.addEventListener('touchmove', move, o);
  doc.addEventListener('touchend', up, o);
  return () => {
    doc.removeEventListener('touchstart', down, o);
    doc.removeEventListener('touchmove', move, o);
    doc.removeEventListener('touchend', up, o);
  };
}
