// 长按拿起、拖着走的底层（R-429 拖动排序，主持人 11-15 定：kit 手写一份长按拖动，待办页、随手记页、隐私记页三处共用，不用 dnd-kit；
// 电脑版布局拖面板 DeskLayout 用的是 dnd-kit，两套各管各的，不混用）。经 gestures.ts 出口给 kit 的 useSortDrag 用，不进首屏的 main 块。
// 这里只管手势，不管“落在哪”和数据：
// • 按住 LIFT_MS（0.4 秒）没动才拿起；没到时间先走过 SLOP_PX（同左滑的起滑距离）就放手不管，交给左滑（kit SwipeRow）或页面滚动
// • 挂在整张列表的外框元素上（一页一个；调用方用回调 ref 交元素，电脑版换挂、断点切换时外框换了就重挂），按下落在哪一行由调用方的 pick 认（行上的 data 标记）；左边缘 20 px 以内起手让给系统返回（同 hdrag.ts）
// • 拿起那一刻：
//   – 给按下的那个元素补发一次 pointercancel（只给这一个指针）：左滑行（hdrag.ts）按“浏览器收走了这次触摸”收尾，不会再把后面的移动当成横滑；
//     自己补发的这一下外框的监听不认
//   – 不分指针类型把指针抓到外框上（setPointerCapture，在补发那一下之后）：触摸原来靠浏览器的隐式捕获抓在按下的那个元素上，
//     手指移到外框外面（底部自动滚动区压着输入行和底栏）照样收得到
//   – 拿起期间这个指针的 pointermove / pointerup / pointercancel 在 window 的捕获阶段收（兜底：捕获没抓上、丢了也收得到；不拦，别处的全局监听照常收到），
//     外框的捕获阶段再拦一道（stopPropagation），行里的左滑、按钮收不到
//   – 非 passive 的 touchmove：拿起以后 preventDefault（iPhone 上手指再动页面不滚）、stopPropagation（下拉搜索在 window 上听的 touchmove 收不到）。
//     外框上常挂一个（iPhone 要按下之前就挂着才拦得住），拿起期间 window 捕获阶段再挂一个兜底；没拿起时什么都不做
//   – 拿起期间拦掉 contextmenu（安卓长按菜单）、selectstart（选字）
// • 拖着走：每次 pointermove 和自动滚动的每一帧都把手指的视口坐标交给 move；手指离滚动区上下边缘 EDGE_SCROLL_PX 以内就自动滚（越近越快），
//   滚动区是外框往上第一个能竖着滚的祖先，没有就是整页
// • 松手交给 drop，随后补来的那一下 click 吞掉（swallow-click.ts，只吞落在外框里的）；
//   取消（浏览器收走这次触摸、按 Esc、切到后台、窗口失焦、外框卸下）交给 cancel，带原因
// • 运行日志由调用方的 log 记（kit 那一层记拿起、放下、取消；这里只记“为什么没拿起”这种手势层的跳过）
// 纯 TS + React 的 useRef / useEffect，不带 motion/react；自动滚动的帧循环用 ./frame-loop.ts 的 eachFrame（A25：帧循环只写在 src/motion）
import { useEffect, useRef } from 'react';
import { eachFrame } from './frame-loop.ts';
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
export function useLongPressDrag(box: HTMLElement | null, opts: LongPressDragOptions): void {
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    if (!box) return undefined;
    let press: Press | null = null;
    let lifted: { id: number; at: Point; scroller: HTMLElement; stop: () => void } | null = null;
    let synthetic = false;
    /** 结束这次拿起的那一下（pointerup / pointercancel）：window 上先收了，外框捕获阶段照样拦住它 */
    let ender: Event | null = null;

    const clearPress = (): void => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    /** 自动滚动：手指在滚动区边缘时每帧滚一点，滚动了就把手指位置再交一次 move */
    const scrollStep = (): void => {
      const l = lifted;
      if (!l) return;
      const s = l.scroller;
      const r = s === document.scrollingElement || s === document.documentElement ? { top: 0, bottom: window.innerHeight } : s.getBoundingClientRect();
      const v = edgeSpeed(l.at.y, Math.max(0, r.top), Math.min(window.innerHeight, r.bottom));
      if (v === 0) return;
      const before = s.scrollTop;
      s.scrollTop = before + v;
      if (s.scrollTop !== before) o.current.move(l.at);
    };
    /** 这一下是不是这次拿起的指针的（含刚结束它的那一下） */
    const ours = (e: PointerEvent): boolean => e === ender || (lifted !== null && e.pointerId === lifted.id);
    const end = (): void => {
      lifted?.stop();
      lifted = null;
      window.removeEventListener('pointermove', onLiftMove, true);
      window.removeEventListener('pointerup', onLiftUp, true);
      window.removeEventListener('pointercancel', onLiftCancel, true);
      window.removeEventListener('touchmove', onTouchMove, true);
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
      // 补发完再抓：补发的那一下照原来的目标发给行里的左滑，抓指针只管之后真的事件
      try {
        box.setPointerCapture(p.id);
      } catch {
        // 指针已经没了（极少见）、浏览器不支持：靠下面 window 上的兜底照样跟
      }
      lifted = { id: p.id, at, scroller: scrollerOf(box), stop: eachFrame(scrollStep) };
      window.addEventListener('pointermove', onLiftMove, true);
      window.addEventListener('pointerup', onLiftUp, true);
      window.addEventListener('pointercancel', onLiftCancel, true);
      window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('contextmenu', block, true);
      window.addEventListener('selectstart', block, true);
      window.addEventListener('blur', onHide);
      document.addEventListener('visibilitychange', onHide);
    };

    const onDown = (e: PointerEvent): void => {
      if (lifted || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      clearPress();
      if (inEdge(e.clientX) || !(e.target instanceof Element)) return;
      const row = o.current.pick(e.target);
      if (!row) return;
      press = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, target: e.target, row, timer: setTimeout(lift, LIFT_MS) };
    };
    // 外框捕获阶段：按住期间看动没动、抬没抬；拿起以后这个指针的事件只拦下（真正的处理在下面 window 上）
    const onMove = (e: PointerEvent): void => {
      if (ours(e)) return void e.stopPropagation();
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) >= SLOP_PX) clearPress();
    };
    const onUp = (e: PointerEvent): void => {
      if (ours(e)) return void e.stopPropagation();
      if (press && e.pointerId === press.id) clearPress();
    };
    const onCancel = (e: PointerEvent): void => {
      if (synthetic) return;
      if (ours(e)) return void e.stopPropagation();
      if (press && e.pointerId === press.id) clearPress();
    };
    // window 捕获阶段（拿起期间才挂）：不管事件落在哪（外框外面、捕获丢了）都在这里收；不拦，别处的全局监听照常收到
    const onLiftMove = (e: PointerEvent): void => {
      if (!lifted || e.pointerId !== lifted.id) return;
      e.preventDefault();
      lifted.at = { x: e.clientX, y: e.clientY };
      o.current.move(lifted.at);
    };
    const onLiftUp = (e: PointerEvent): void => {
      if (!lifted || e.pointerId !== lifted.id) return;
      ender = e;
      lifted.at = { x: e.clientX, y: e.clientY };
      end();
      swallowNextClick({ within: box });
      o.current.drop();
    };
    const onLiftCancel = (e: PointerEvent): void => {
      if (synthetic || !lifted || e.pointerId !== lifted.id) return;
      ender = e;
      cancel('cancel');
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
