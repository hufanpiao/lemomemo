// 长按拿起、拖着走的底层（R-429 拖动排序，主持人 11-15 定：kit 手写一份长按拖动，待办页、随手记页、隐私记页三处共用，不用 dnd-kit；
// 电脑版布局拖面板 DeskLayout 用的是 dnd-kit，两套各管各的，不混用）。经 gestures.ts 出口给 kit 的 useSortDrag 用，不进首屏的 main 块。
// 这里只管手势，不管“落在哪”和数据：
// • 按住 LIFT_MS（0.4 秒）没动才拿起；没到时间先走过 SLOP_PX（同左滑的起滑距离）就放手不管，交给左滑（kit SwipeRow）或页面滚动
// • 挂在整张列表的外框元素上（一页一个；调用方用回调 ref 交元素，电脑版换挂、断点切换时外框换了就重挂），按下落在哪一行由调用方的 pick 认（行上的 data 标记）；左边缘 20 px 以内起手让给系统返回（同 hdrag.ts）
// • 拿起那一刻：
//   – 给按下的那个元素补发一次 pointercancel（只给这一个指针）：左滑行（hdrag.ts）按“浏览器收走了这次触摸”收尾，不会再把后面的移动当成横滑；
//     自己补发的这一下外框的监听不认
//   – 之后这个指针的 pointermove / pointerup 在外框的捕获阶段就拦下（stopPropagation），行里的左滑、按钮收不到
//   – 外框上常挂一个非 passive 的 touchmove：拿起以后 preventDefault（iPhone 上手指再动页面不滚）、stopPropagation（下拉搜索在 window 上听的 touchmove 收不到）；
//     没拿起时什么都不做
//   – 拿起期间拦掉 contextmenu（安卓长按菜单）、selectstart（选字）；鼠标的话把指针抓到外框上（拖出外框照样跟）
// • 拖着走：每次 pointermove 和自动滚动的每一帧都把手指的视口坐标交给 move；手指离滚动区上下边缘 EDGE_SCROLL_PX 以内就自动滚（越近越快），
//   滚动区是外框往上第一个能竖着滚的祖先，没有就是整页
// • 松手交给 drop，随后补来的那一下 click 吞掉（swallow-click.ts，只吞落在外框里的）；
//   取消（浏览器收走这次触摸、按 Esc、切到后台、窗口失焦、外框卸下）交给 cancel，带原因
// • 运行日志由调用方的 log 记（kit 那一层记拿起、放下、取消；这里只记“为什么没拿起”这种手势层的跳过）
// 纯 TS + React 的 useRef / useEffect，不带 motion/react；requestAnimationFrame 按 A25 只写在这里（src/motion）
import { useEffect, useRef } from 'react';
import { inEdge, SLOP_PX } from './hdrag.ts';
import { swallowNextClick } from './swallow-click.ts';

/** 按住多久拿起（毫秒；R-429 原文“长按 0.4 秒没动才拿起”） */
export const LIFT_MS = 400;
/** 手指离滚动区上、下边缘多近开始自动滚（px）；下边缘多留一截给底栏和随手记的输入行 */
export const EDGE_SCROLL_PX = { top: 72, bottom: 140 } as const;
/** 自动滚每帧最多滚多少（px） */
const SCROLL_MAX_PX = 14;

export interface Point {
  x: number;
  y: number;
}

export interface LongPressDragOptions {
  /** 按下落在哪一行（target 往上找调用方的标记）；回 null 这一下不管 */
  pick(target: Element): HTMLElement | null;
  /** 按住够久了：回 false 不拿（例如这一行正露着左滑按钮） */
  lift(row: HTMLElement, at: Point): boolean;
  /** 拿起以后手指的视口坐标（每次指针动、每帧自动滚之后） */
  move(at: Point): void;
  drop(): void;
  cancel(why: 'cancel' | 'esc' | 'hidden' | 'unmount'): void;
}

interface Press {
  id: number;
  type: string;
  x0: number;
  y0: number;
  target: Element;
  row: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
}

/** 外框往上第一个能竖着滚的祖先；没有就是整页 */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** 手指在滚动区里离边缘多近 → 这一帧滚多少（上负下正，不在边缘为 0） */
function edgeSpeed(y: number, top: number, bottom: number): number {
  const up = y - top;
  const down = bottom - y;
  if (up < EDGE_SCROLL_PX.top) return -Math.ceil(SCROLL_MAX_PX * Math.min(1, (EDGE_SCROLL_PX.top - up) / EDGE_SCROLL_PX.top));
  if (down < EDGE_SCROLL_PX.bottom) return Math.ceil(SCROLL_MAX_PX * Math.min(1, (EDGE_SCROLL_PX.bottom - down) / EDGE_SCROLL_PX.bottom));
  return 0;
}

/** 挂到列表外框元素上（box 换了就重挂；null 不挂） */
/** 从下一帧起每帧调一次 step，直到它回 true；返回取消函数（kit SortDrag 放下后等列表画好、浮层归位用，A25：帧循环只写在 motion 里） */
export function eachFrame(step: () => boolean): () => void {
  let id = 0;
  let dead = false;
  const tick = (): void => {
    if (dead || step()) return;
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => {
    dead = true;
    cancelAnimationFrame(id);
  };
}

export function useLongPressDrag(box: HTMLElement | null, opts: LongPressDragOptions): void {
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    if (!box) return undefined;
    let press: Press | null = null;
    let lifted: { id: number; at: Point; scroller: HTMLElement; frame: number } | null = null;
    let synthetic = false;

    const clearPress = (): void => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    const stopLoop = (): void => {
      if (lifted) cancelAnimationFrame(lifted.frame);
    };
    const tick = (): void => {
      const l = lifted;
      if (!l) return;
      const s = l.scroller;
      const r = s === document.scrollingElement || s === document.documentElement ? { top: 0, bottom: window.innerHeight } : s.getBoundingClientRect();
      const v = edgeSpeed(l.at.y, Math.max(0, r.top), Math.min(window.innerHeight, r.bottom));
      if (v !== 0) {
        const before = s.scrollTop;
        s.scrollTop = before + v;
        if (s.scrollTop !== before) o.current.move(l.at);
      }
      l.frame = requestAnimationFrame(tick);
    };
    const end = (): void => {
      stopLoop();
      lifted = null;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', block, true);
      window.removeEventListener('selectstart', block, true);
      window.removeEventListener('blur', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
    const cancel = (why: 'cancel' | 'esc' | 'hidden' | 'unmount'): void => {
      if (!lifted) return;
      end();
      o.current.cancel(why);
    };
    const block = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      block(e);
      cancel('esc');
    };
    const onHide = (): void => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) cancel('hidden');
    };

    const lift = (): void => {
      const p = press;
      press = null;
      if (!p || !p.row.isConnected) return;
      const at = { x: p.x0, y: p.y0 };
      if (!o.current.lift(p.row, at)) return;
      // 行里的左滑按这一下“被收走了”收尾（见文件头）；自己补发的这一下下面的监听不认
      if (typeof PointerEvent === 'function') {
        synthetic = true;
        try {
          p.target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: p.id, pointerType: p.type, isPrimary: true }));
        } finally {
          synthetic = false;
        }
      }
      if (p.type === 'mouse') {
        try {
          box.setPointerCapture(p.id);
        } catch {
          // 指针已经没了（极少见）：照样跟
        }
      }
      lifted = { id: p.id, at, scroller: scrollerOf(box), frame: 0 };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('contextmenu', block, true);
      window.addEventListener('selectstart', block, true);
      window.addEventListener('blur', onHide);
      document.addEventListener('visibilitychange', onHide);
      lifted.frame = requestAnimationFrame(tick);
    };

    const onDown = (e: PointerEvent): void => {
      if (lifted || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      clearPress();
      if (inEdge(e.clientX) || !(e.target instanceof Element)) return;
      const row = o.current.pick(e.target);
      if (!row) return;
      press = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, target: e.target, row, timer: setTimeout(lift, LIFT_MS) };
    };
    const onMove = (e: PointerEvent): void => {
      if (lifted) {
        if (e.pointerId !== lifted.id) return;
        e.stopPropagation();
        e.preventDefault();
        lifted.at = { x: e.clientX, y: e.clientY };
        o.current.move(lifted.at);
        return;
      }
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) >= SLOP_PX) clearPress();
    };
    const onUp = (e: PointerEvent): void => {
      if (press && e.pointerId === press.id) clearPress();
      if (!lifted || e.pointerId !== lifted.id) return;
      e.stopPropagation();
      lifted.at = { x: e.clientX, y: e.clientY };
      end();
      swallowNextClick({ within: box });
      o.current.drop();
    };
    const onCancel = (e: PointerEvent): void => {
      if (synthetic) return;
      if (press && e.pointerId === press.id) clearPress();
      if (lifted && e.pointerId === lifted.id) cancel('cancel');
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (!lifted) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    };

    box.addEventListener('pointerdown', onDown, true);
    box.addEventListener('pointermove', onMove, true);
    box.addEventListener('pointerup', onUp, true);
    box.addEventListener('pointercancel', onCancel, true);
    box.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    return () => {
      clearPress();
      cancel('unmount');
      box.removeEventListener('pointerdown', onDown, true);
      box.removeEventListener('pointermove', onMove, true);
      box.removeEventListener('pointerup', onUp, true);
      box.removeEventListener('pointercancel', onCancel, true);
      box.removeEventListener('touchmove', onTouchMove, true);
    };
  }, [box]);
}
