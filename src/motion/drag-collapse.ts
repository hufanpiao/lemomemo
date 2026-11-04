// 上下拖动收起 / 展开（B2 FA-3 补：月历“往上拖列表，月历收成一周一行”，定稿线框 s3；架构 17.2）
// • 进度 p：0 = 展开、1 = 收起。页面只按 p 画 transform 和 opacity（17.2 第 6 点），布局不变
// • 跟手：按住拖动柄上下拖，p 跟着手指走（往上拖变大）；拖过的距离按 range（展开和收起两种位置相差多少像素）换算
// • 松手吸附：甩得够快按方向（≥ 0.5 px/ms），否则过半收起、不过半弹回；补间用 --dur-ui、--ease-out（tokens.ts 的 dur.ui、ease.out）
// • 可中断：补间途中再按住，从当前的 p 接着拖
// • 横向先动的不算（让给左右翻页）；从屏幕左边 20 px 起手的不接（让给系统返回）
// • 减少动态效果：不跟手，松手按拖的方向和距离直接切换，没有补间
// • 键盘、读屏：拖动柄本身是按钮，点一下（回车、空格）就切换，页面调 toggle（同样有补间、减少动态效果时直接切）
import { useCallback, useEffect, useRef, useState } from 'react';
import { inEdge, LOCK_PX } from './swipe-pager.ts';
import { dur, ease, type Bezier } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

/** 过了这个比例就收起（不过就弹回） */
export const SNAP_FRAC = 0.5;
/** 甩动速度阈值（px/ms），过了就按甩的方向 */
export const FLICK_PX_PER_MS = 0.5;

/** 从 from 开始拖了 dy（往下为正）后的进度 */
export function dragProgress(from: number, dy: number, range: number): number {
  if (!(range > 0)) return from;
  return Math.min(1, Math.max(0, from - dy / range));
}

/** 松手时该停在哪一头：vy 是竖直速度（往下为正，px/ms） */
export function snapTarget(p: number, vy: number): 0 | 1 {
  if (vy <= -FLICK_PX_PER_MS) return 1;
  if (vy >= FLICK_PX_PER_MS) return 0;
  return p >= SNAP_FRAC ? 1 : 0;
}

/** cubic-bezier 曲线在时间 x（0～1）处的进度 */
export function bezierAt(b: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = b;
  const at = (a1: number, a2: number, t: number): number => 3 * a1 * t * (1 - t) ** 2 + 3 * a2 * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 30; i += 1) {
    t = (lo + hi) / 2;
    if (at(x1, x2, t) < x) lo = t;
    else hi = t;
  }
  return at(y1, y2, t);
}

type PtrLike = Pick<React.PointerEvent<HTMLElement>, 'pointerId' | 'isPrimary' | 'clientX' | 'clientY' | 'timeStamp'>;

interface Track {
  id: number;
  x: number;
  y: number;
  from: number;
  range: number;
  lock: 'none' | 'y' | 'x';
  lastY: number;
  lastT: number;
  vy: number;
}

export interface DragCollapse {
  /** 当前进度：0 展开、1 收起 */
  readonly progress: number;
  /** 正在拖或正在补间 */
  readonly moving: boolean;
  onPointerDown(e: PtrLike): void;
  onPointerMove(e: PtrLike): void;
  onPointerUp(e: PtrLike): void;
  onPointerCancel(): void;
  /** 拖过以后吞掉那一下点击（免得松手又当成点了按钮） */
  onClickCapture(e: React.MouseEvent<HTMLElement>): void;
  /** 键盘、读屏、点按：切换 */
  toggle(): void;
}

/**
 * collapsed：页面记的状态；onChange：吸附或 toggle 定下新状态时调；rangeOf：按下时量展开和收起两种位置相差多少像素
 */
export function useDragCollapse(collapsed: boolean, onChange: (collapsed: boolean) => void, rangeOf: () => number): DragCollapse {
  const reduced = useReducedMotionPref();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const [p, setP] = useState(collapsed ? 1 : 0);
  const pRef = useRef(p);
  const [moving, setMoving] = useState(false);
  const track = useRef<Track | null>(null);
  const raf = useRef<number | null>(null);
  const swallow = useRef(false);
  const cb = useRef(onChange);
  cb.current = onChange;
  const range = useRef(rangeOf);
  range.current = rangeOf;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const set = useCallback((v: number) => {
    pRef.current = v;
    setP(v);
  }, []);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  const animateTo = useCallback(
    (target: 0 | 1) => {
      stop();
      const from = pRef.current;
      if (reducedRef.current || from === target) {
        set(target);
        setMoving(false);
        return;
      }
      setMoving(true);
      const t0 = performance.now();
      const ms = dur.ui * 1000;
      // 帧里也用 performance.now()，和 t0 同一个时钟（不用 rAF 回调给的时间戳：个别环境两者对不上，补间收不到终点）
      const frame = (): void => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        set(from + (target - from) * bezierAt(ease.out, k));
        if (k < 1) raf.current = requestAnimationFrame(frame);
        else {
          raf.current = null;
          setMoving(false);
        }
      };
      raf.current = requestAnimationFrame(frame);
    },
    [set, stop],
  );

  // 外面改了状态（按钮、翻到别的月份后重置等）：补间到那一头；拖动中不管
  useEffect(() => {
    if (track.current) return;
    animateTo(collapsed ? 1 : 0);
  }, [collapsed, animateTo]);

  useEffect(() => stop, [stop]);

  const onPointerDown = useCallback(
    (e: PtrLike) => {
      swallow.current = false;
      if (!e.isPrimary || inEdge(e.clientX)) return;
      stop();
      track.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: pRef.current, range: range.current(), lock: 'none', lastY: e.clientY, lastT: e.timeStamp, vy: 0 };
      setMoving(true);
    },
    [stop],
  );

  const onPointerMove = useCallback(
    (e: PtrLike) => {
      const t = track.current;
      if (!t || t.id !== e.pointerId) return;
      const dx = e.clientX - t.x;
      const dy = e.clientY - t.y;
      if (t.lock === 'none' && Math.max(Math.abs(dx), Math.abs(dy)) >= LOCK_PX) t.lock = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      if (t.lock !== 'y') return;
      const dt = e.timeStamp - t.lastT;
      if (dt > 0) t.vy = (e.clientY - t.lastY) / dt;
      t.lastY = e.clientY;
      t.lastT = e.timeStamp;
      if (!reducedRef.current) set(dragProgress(t.from, dy, t.range));
    },
    [set],
  );

  const onPointerUp = useCallback(
    (e: PtrLike) => {
      const t = track.current;
      track.current = null;
      if (!t || t.id !== e.pointerId || t.lock !== 'y') {
        // 没锁成竖向（点一下、横向）：回到页面记的状态，画面和 aria-expanded、inert 一致（代码复审 R1）
        if (t) animateTo(collapsedRef.current ? 1 : 0);
        return;
      }
      swallow.current = true;
      const now = dragProgress(t.from, e.clientY - t.y, t.range);
      const target = snapTarget(now, t.vy);
      animateTo(target);
      if ((target === 1) !== collapsedRef.current) cb.current(target === 1);
    },
    [animateTo],
  );

  const onPointerCancel = useCallback(() => {
    track.current = null;
    // 取消（系统手势接管等）：一律回到页面记的状态，不按按下时的进度吸附（代码复审 R1：补间途中被取消会画面展开、状态还是收起）
    animateTo(collapsedRef.current ? 1 : 0);
  }, [animateTo]);

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!swallow.current) return;
    swallow.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const toggle = useCallback(() => cb.current(!collapsedRef.current), []);

  return { progress: p, moving, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, toggle };
}
