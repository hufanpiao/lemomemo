// 所有页面顶部固定：在顶部往下拉页面不动，只出搜索框（只关顶部回弹）
// • 整页滚到顶（atTop）时，除了明显往上推（pushesUp：竖着为主、往上，页面往下滚），这一整下 touchmove 都拦下默认，
//   iOS 不再把整页往下拽出回弹（竖拉、斜拉、边缘横划换页都算）
// • 一下手势只在第一次有位移的 touchmove 定一次（iOS 第一下没拦，原生滚动就接手了，后面再拦也拦不住）：
//   往上推、不在顶上、按在里面一块还能往上滚（竖）或能横着滚（分类胶囊行）的框里：这一下整段放行（底部回弹保留）
// • 下拉搜索（kit/hooks/usePullReveal.ts）听同一串 touch 事件，判断“在不在顶上、是不是往下拉、框能不能滚”
//   用这里导出的同一份（两处门槛不一样时，斜着拉会页面锁住、搜索框又不出）
// • 运行日志：在顶上往下拉的那一下记 toplock block / pass inner / pass uncancelable
// • 一个窗口装一次（app/main.tsx 启动时）；非被动监听，React 的 onTouchMove 给不了
import { rlog } from './run-log-api.ts';

/** 整页滚到顶了 */
export const atTop = (): boolean => window.scrollY <= 0;

/** 从按下到现在的位移算不算“往下拉”：往下、横向不超过竖向一半 */
export const pullsDown = (dx: number, dy: number): boolean => dy > 0 && Math.abs(dx) * 2 < dy;

/** 明显往上推（竖着为主、往上）：页面要正常往下滚，顶部锁不拦 */
const pushesUp = (dx: number, dy: number): boolean => dy < 0 && Math.abs(dy) > Math.abs(dx);

/** 这一块竖着真能滚（overflow-y auto / scroll，内容比框高） */
export const scrollsY = (el: Element, cs: CSSStyleDeclaration = getComputedStyle(el)): boolean =>
  (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;

const scrollsX = (el: Element, cs: CSSStyleDeclaration): boolean =>
  (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth;

/** 这一块竖着还没滚到底（留 1px 容差：缩放时 scrollTop 是小数） */
const moreBelow = (el: Element): boolean => el.scrollTop + el.clientHeight < el.scrollHeight - 1;

/** 整页真有东西可滚：手机上 base.css 给 html 多加 1px，不算；弹层打开（scroll-locked）时整页不该动 */
const pageScrolls = (): boolean => {
  const d = document.documentElement;
  return d.scrollHeight - d.clientHeight > 1 && !d.classList.contains('scroll-locked');
};

/** 按下的元素往上，有没有一块该交给它自己滚的框。
 *  往下拉、横划：竖着还能往上滚，或者能横着滚；往上推（up）：只看竖着还没到底的框，横滑行和到底的框接不住这一下，放行会拽走整页 */
export function innerScrolls(t: EventTarget | null, up = false): boolean {
  for (let el = t instanceof Element ? t : null; el !== null && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (up ? scrollsY(el, cs) && moreBelow(el) : (scrollsY(el, cs) && el.scrollTop > 0) || scrollsX(el, cs)) return true;
  }
  return false;
}

let installed = false;

/** 装上；返回卸掉的函数（测试用） */
export function installTopLock(): () => void {
  if (installed) return () => undefined;
  installed = true;
  let start: { x: number; y: number; t: EventTarget | null } | null = null;
  /** 这一下定了没有：null 还没定，true 拦，false 放行 */
  let lock: boolean | null = null;
  const onStart = (e: TouchEvent): void => {
    const p = e.touches[0];
    start = e.touches.length === 1 && p ? { x: p.clientX, y: p.clientY, t: e.target } : null;
    lock = null;
  };
  const onMove = (e: TouchEvent): void => {
    const p = e.touches[0];
    if (!start || !p || e.touches.length !== 1) return;
    if (lock === null) {
      const dx = p.clientX - start.x;
      const dy = p.clientY - start.y;
      if (dx === 0 && dy === 0) return;
      // 在顶上：除了明显往上推（页面往下滚，照常放行），都拦下默认。只认“竖着往下”会放过边缘横划和斜着的竖拉，iOS 照样把整页往下拽。
      // 换页（tab-swipe.ts）、行左滑、下拉搜索都只听 touch 自己算，不靠默认滚动，拦了不受影响
      // 内容没超过一屏时往上推也拦：没东西可滚，放行只会把整页拽走
      const up = pushesUp(dx, dy);
      const top = atTop() && (!up || !pageScrolls());
      const inner = top && innerScrolls(start.t, up);
      lock = top && e.cancelable && !inner;
      // 运行日志：在顶上、不是往上推的那一下怎么定的（拦了 / 事件不让拦 / 交给里面能滚的框），带第一下的位移
      if (top) rlog(`toplock ${lock ? 'block' : inner ? 'pass inner' : 'pass uncancelable'} dx=${Math.round(dx)} dy=${Math.round(dy)} y=${Math.round(window.scrollY)}`);
    }
    if (lock && e.cancelable) e.preventDefault();
  };
  const onEnd = (): void => {
    start = null;
    lock = null;
  };
  window.addEventListener('touchstart', onStart, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onEnd, { passive: true });
  window.addEventListener('touchcancel', onEnd, { passive: true });
  return () => {
    installed = false;
    window.removeEventListener('touchstart', onStart);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onEnd);
    window.removeEventListener('touchcancel', onEnd);
  };
}
