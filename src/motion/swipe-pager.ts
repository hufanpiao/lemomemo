// 左右滑动翻页（B2 FA-3：月历、周视图上一页 / 下一页，架构 5.12 第 3 点、17.2）
// • 只认“明显是横着滑”的手势：先动够 LOCK_PX，横向位移大于竖向才锁成横滑（5.12“横向速度大于纵向”）；先竖着动就整段交给页面滚动
// • 不和系统返回手势抢：从屏幕左边缘 EDGE_PX（20 px，5.12）以内起手的不管（iPhone 侧滑返回）
// • 松手时横向位移超过 TRIGGER_PX（60 px，5.12）才翻；向左滑 = 下一页，向右滑 = 上一页
// • 跟手（5.12 动效）：锁成横滑后内容跟着手指移动（offset）；松手翻页时新的一页从被拖出的那一侧接着滑进来，
//   不翻就滑回原位，都用 --dur-ui、--ease-standard（由页面 CSS 按 settling 加 transition）；减少动态效果时不跟手、直接切换
// • 按钮翻页（slideIn）：页面换好新的一页后调，新的一页同样从那一侧滑进来；键盘、“今天”、年月选择不调（直接切换）
// • 滑过之后紧跟的那次 click 吞掉（onClickCapture），免得翻页的同时点中格子
// • 只处理触摸和笔（pointerType 为 mouse 不算，电脑上用按钮和键盘翻页）；元素要配 CSS touch-action: pan-y，竖向滚动仍是原生的
// rAF 只在这里用（A25：页面里不直接用 rAF）
import { useCallback, useRef, useState } from 'react';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export const EDGE_PX = 20;
export const LOCK_PX = 10;
export const TRIGGER_PX = 60;

export type SwipeLock = 'none' | 'x' | 'y';

/** 按目前的位移判断锁成哪个方向（纯函数，便于测试） */
export function lockOf(dx: number, dy: number): SwipeLock {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < LOCK_PX) return 'none';
  return ax > ay ? 'x' : 'y';
}

/** 起手点在不在屏幕左边缘的系统手势区里 */
export function inEdge(x: number): boolean {
  return x < EDGE_PX;
}

/** 松手时翻不翻：-1 上一页，1 下一页，0 不翻 */
export function swipeResult(dx: number): -1 | 0 | 1 {
  if (Math.abs(dx) < TRIGGER_PX) return 0;
  return dx < 0 ? 1 : -1;
}

/** 翻页后新的一页从哪儿接着滑进来：下一页（向左滑）从右边、上一页从左边，带上手指已经拖出的那段 */
export function enterOffset(dir: -1 | 1, dx: number, width: number): number {
  return dir === 1 ? width + dx : dx - width;
}

interface Track {
  id: number;
  x: number;
  y: number;
  lock: SwipeLock;
  width: number;
}

/** 把 pointer 事件挂到要能左右滑的那块上；offset、settling 交给页面画位移 */
export interface SwipePagerHandlers {
  onPointerDown(e: React.PointerEvent<HTMLElement>): void;
  onPointerMove(e: React.PointerEvent<HTMLElement>): void;
  onPointerUp(e: React.PointerEvent<HTMLElement>): void;
  onPointerCancel(): void;
  onClickCapture(e: React.MouseEvent<HTMLElement>): void;
  /** 按钮翻页：已经换到新的一页后调，新的一页从那一侧滑进来（5.12：按钮翻页用同样的滑动）；减少动态效果时什么都不做 */
  slideIn(dir: -1 | 1, width: number): void;
  /** 现在内容该横移多少 px（跟手、或滑到位途中）；0 是原位 */
  readonly offset: number;
  /** true：offset 的变化要带过渡（松手后滑到位）；false：直接跟手 */
  readonly settling: boolean;
}

type PtrLike = Pick<React.PointerEvent<HTMLElement>, 'pointerType' | 'isPrimary' | 'pointerId' | 'clientX' | 'clientY'> & {
  currentTarget: { getBoundingClientRect(): { width: number } };
};

/** onPage(-1) 上一页、onPage(1) 下一页 */
export function useSwipePager(onPage: (dir: -1 | 1) => void): SwipePagerHandlers {
  const track = useRef<Track | null>(null);
  const cb = useRef(onPage);
  cb.current = onPage;
  const reduced = useReducedMotionPref();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const swallowClick = useRef(false);

  const onPointerDown = useCallback((e: PtrLike) => {
    swallowClick.current = false;
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    if (inEdge(e.clientX)) {
      track.current = null;
      return;
    }
    setSettling(false);
    track.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lock: 'none', width: e.currentTarget.getBoundingClientRect().width };
  }, []);

  const onPointerMove = useCallback((e: PtrLike) => {
    const t = track.current;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x;
    if (t.lock === 'none') t.lock = lockOf(dx, e.clientY - t.y);
    if (t.lock === 'x' && !reducedRef.current) setOffset(dx);
  }, []);

  const onPointerUp = useCallback((e: PtrLike) => {
    const t = track.current;
    track.current = null;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x;
    const lock = t.lock === 'none' ? lockOf(dx, e.clientY - t.y) : t.lock;
    if (lock !== 'x') {
      setOffset(0);
      return;
    }
    swallowClick.current = Math.abs(dx) >= LOCK_PX;
    const r = swipeResult(dx);
    if (reducedRef.current) {
      setOffset(0);
      if (r !== 0) cb.current(r);
      return;
    }
    if (r === 0) {
      // 不够：滑回原位
      setSettling(true);
      setOffset(0);
      return;
    }
    cb.current(r);
    // 新的一页先放在被拖出的那一侧（不带过渡），下一帧再带过渡滑到 0
    setSettling(false);
    setOffset(enterOffset(r, dx, t.width));
    requestAnimationFrame(() => {
      setSettling(true);
      setOffset(0);
    });
  }, []);

  const onPointerCancel = useCallback(() => {
    track.current = null;
    setSettling(true);
    setOffset(0);
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const slideIn = useCallback((dir: -1 | 1, width: number) => {
    if (reducedRef.current || !(width > 0)) return;
    setSettling(false);
    setOffset(enterOffset(dir, 0, width));
    requestAnimationFrame(() => {
      setSettling(true);
      setOffset(0);
    });
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, slideIn, offset, settling };
}
