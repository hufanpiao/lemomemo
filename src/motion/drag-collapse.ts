// 上下拖动收起 / 展开（B2 FA-3 补：月历“往上拖列表，月历收成一周一行”，定稿线框 s3；架构 17.2）
// • 进度 p：0 = 展开、1 = 收起。进度不进 React state：每次变化调 onFrame(p)，页面直接写 DOM（17.2 第 6 点；R-457：动画途中整页不重画，
//   不然列表里 Motion 的 layout 每一帧都以为位置变了、自己补一段平移，待办组比日程行慢一拍）。只有开始、停稳两次重画（moving）
// • 跟手：按住拖动柄上下拖，p 跟着手指走（往上拖变大）；拖过的距离按 range（展开和收起两种位置相差多少像素）换算，
//   range 在锁成竖拖那一下才量（按下那一下页面才换成可动画的排布，按下时量不到）
// • 松手吸附：甩得够快按方向（≥ 0.5 px/ms），否则过半收起、不过半弹回；带着手指的速度用项目弹簧弹过去（tokens.ts spring，R-457）；
//   点拖动柄切换也用同一个弹簧（初速 0）。进度夹在 0～1：弹簧的一点点过冲不画出来（日清单不压锚点那一行）
// • 可中断：弹到一半再按住，从当前的 p 接着拖
// • 运行日志：停稳时记“fold open→folded via=drag|tap ms=”（R-457；页面加“cal ”前缀、补别的字段）
// • 横向先动的不算（让给左右翻页）；从屏幕左边 20 px 起手的不接（让给系统返回）
// • 减少动态效果：不跟手，松手按拖的方向和距离直接切换，没有补间
// • 键盘、读屏：拖动柄本身是按钮，点一下（回车、空格）就切换，页面调 toggle（同样有补间、减少动态效果时直接切）
import { useCallback, useEffect, useRef, useState } from 'react';
import { inEdge, SLOP_PX } from './hdrag.ts';
import { SPRING_DAMPING_RATIO, SPRING_MASS, SPRING_STIFFNESS, type Bezier } from './tokens.ts';
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
  /** 展开和收起相差多少像素；-1 = 还没量（锁成竖拖时量） */
  range: number;
  lock: 'none' | 'y' | 'x';
  lastY: number;
  lastT: number;
  vy: number;
}

export interface DragCollapse {
  /** 当前进度：0 展开、1 收起（读的是此刻的值，不随它重画） */
  readonly progress: number;
  /** 正在拖或正在弹（开始、停稳各重画一次） */
  readonly moving: boolean;
  /** 最后一次停稳在哪一头（0 展开、1 收起）；页面据此换排布（停稳会重画，减少动态效果时直接切换也一样） */
  readonly rest: 0 | 1;
  onPointerDown(e: PtrLike): void;
  onPointerMove(e: PtrLike): void;
  onPointerUp(e: PtrLike): void;
  onPointerCancel(): void;
  /** 拖过以后吞掉那一下点击（免得松手又当成点了按钮） */
  onClickCapture(e: React.MouseEvent<HTMLElement>): void;
  /** 键盘、读屏、点按：切换 */
  toggle(): void;
}

/** 运行日志里两头的写法 */
const STATE = ['open', 'folded'] as const;

/** 弹簧的状态：位置（进度）、速度（进度 / 秒） */
export interface SpringState {
  x: number;
  v: number;
}

export const springState = (x: number, v: number): SpringState => ({ x, v });

/** 弹簧停稳的判定：离终点和速度都小到看不出来 */
const REST_X = 0.001;
const REST_V = 0.01;

/**
 * 项目弹簧（tokens.ts：刚度 380、阻尼比 0.78、质量 1）往 to 走 dt 秒，原地改 s；停稳了返回 true。
 * 一帧最多算 32 ms（切到后台回来不一下跳过头），分 4 小步（半隐式欧拉，步长小才稳）
 */
export function springStep(s: SpringState, to: number, dt: number): boolean {
  const k = SPRING_STIFFNESS / SPRING_MASS;
  const c = (2 * SPRING_DAMPING_RATIO * Math.sqrt(SPRING_STIFFNESS * SPRING_MASS)) / SPRING_MASS;
  const h = Math.min(0.032, Math.max(0, dt)) / 4;
  for (let i = 0; i < 4; i += 1) {
    s.v += (-k * (s.x - to) - c * s.v) * h;
    s.x += s.v * h;
  }
  return Math.abs(s.x - to) < REST_X && Math.abs(s.v) < REST_V;
}

export interface DragCollapseOpts {
  /** 进度每变一次调一次（跟手、弹簧的每一帧、停稳）：页面在这里直接写 DOM */
  onFrame?: ((p: number) => void) | undefined;
  /** 停稳时记一行运行日志“fold open→folded via=drag ms=…”（调用方加前缀；只记手势，不记内容） */
  log?: ((line: string) => void) | undefined;
}

/**
 * collapsed：页面记的状态；onChange：吸附或 toggle 定下新状态时调；rangeOf：展开和收起两种位置相差多少像素（锁成竖拖时量）
 */
export function useDragCollapse(collapsed: boolean, onChange: (collapsed: boolean) => void, rangeOf: () => number, opts: DragCollapseOpts = {}): DragCollapse {
  const reduced = useReducedMotionPref();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const pRef = useRef(collapsed ? 1 : 0);
  const frameRef = useRef(opts.onFrame);
  frameRef.current = opts.onFrame;
  const [moving, setMoving] = useState(false);
  const [rest, setRest] = useState<0 | 1>(collapsed ? 1 : 0);
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
    frameRef.current?.(v);
  }, []);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  /** 这一次切换是怎么起的（拖、点）和起点：停稳时记一行运行日志 */
  const why = useRef<{ via: 'drag' | 'tap'; from: 0 | 1; t0: number } | null>(null);
  const target = useRef<0 | 1>(collapsed ? 1 : 0);
  const logRef = useRef(opts.log);
  logRef.current = opts.log;
  const settle = useCallback(
    (to: 0 | 1) => {
      set(to);
      setRest(to);
      setMoving(false);
      raf.current = null;
      const w = why.current;
      why.current = null;
      if (w) logRef.current?.(`fold ${STATE[w.from]}→${STATE[to]} via=${w.via} ms=${Math.round(performance.now() - w.t0)}`);
    },
    [set],
  );

  /** 弹到 to：项目弹簧（tokens.ts spring，R-457“松手用项目弹簧”），v0 是松手时的速度（进度 / 秒）；减少动态效果时直接到 */
  const animateTo = useCallback(
    (to: 0 | 1, v0 = 0) => {
      stop();
      target.current = to;
      if (reducedRef.current || (pRef.current === to && v0 === 0)) {
        settle(to);
        return;
      }
      setMoving(true);
      const s = springState(pRef.current, v0);
      let last = performance.now();
      // 帧里用 performance.now() 算步长（不用 rAF 回调给的时间戳：个别环境两者对不上）
      const frame = (): void => {
        const now = performance.now();
        if (springStep(s, to, (now - last) / 1000)) return settle(to);
        last = now;
        set(Math.min(1, Math.max(0, s.x)));
        raf.current = requestAnimationFrame(frame);
      };
      raf.current = requestAnimationFrame(frame);
    },
    [set, settle, stop],
  );

  // 外面改了状态（按钮、翻到别的月份后重置等）：弹到那一头；拖动中、已经在往那一头弹的不管（松手时带着手指速度弹起来了，不重来）
  useEffect(() => {
    const to = collapsed ? 1 : 0;
    if (track.current || target.current === to) return;
    animateTo(to);
  }, [collapsed, animateTo]);

  useEffect(() => stop, [stop]);

  const onPointerDown = useCallback(
    (e: PtrLike) => {
      swallow.current = false;
      if (!e.isPrimary || inEdge(e.clientX)) return;
      stop();
      track.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: pRef.current, range: -1, lock: 'none', lastY: e.clientY, lastT: e.timeStamp, vy: 0 };
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
      if (t.lock === 'none' && Math.max(Math.abs(dx), Math.abs(dy)) >= SLOP_PX) t.lock = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      if (t.lock !== 'y') return;
      if (t.range < 0) t.range = range.current();
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
      const to = snapTarget(now, t.vy);
      why.current = { via: 'drag', from: collapsedRef.current ? 1 : 0, t0: performance.now() };
      // 带着手指的速度弹（往上拖 vy 为负、进度变大）；减少动态效果时 animateTo 直接到
      animateTo(to, t.range > 0 ? (-t.vy * 1000) / t.range : 0);
      if ((to === 1) !== collapsedRef.current) cb.current(to === 1);
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

  const toggle = useCallback(() => {
    why.current = { via: 'tap', from: collapsedRef.current ? 1 : 0, t0: performance.now() };
    cb.current(!collapsedRef.current);
  }, []);

  return {
    get progress() {
      return pRef.current;
    },
    moving,
    rest,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
    toggle,
  };
}
