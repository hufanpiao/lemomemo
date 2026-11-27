// 看图页的缩放和拖动：随手记、隐私记共用 ui/ImageViewer.tsx，手势都在这一份
// • 双指捏合 1～4 倍，以两指中点为中心；放大后单指拖，不能拖出图片边界；双击在 1 倍和 2.5 倍之间切换
// • 只有 1 倍、单指、全程没出现过第二根手指时才算横滑换张；放大时和捏合刚结束都不换张
// • 只动 transform，直接写到 DOM 上，手势中不触发 React 重画；用 2D transform，避免 iOS 按 1 倍栅格化后放大发糊
// • 减弱动态效果（prefersReducedMotion）时双击切换不带动画；捏合和拖动本来就跟手，没有动画
// • 运行日志只记“放大了 / 回到 1 倍”这两个状态，不记图、不记位置
import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { TAP_SLOP_PX } from '../../../../shared/logic/gesture.ts';
import { prefersReducedMotion } from '../../../motion/index.ts';
import { rlog } from '../../../platform/run-log-api.ts';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const ZOOM_TAP = 2.5;
/** 横向滑多远算换张（像素） */
const SWIPE_PX = 48;
/** 一次点按最长多久、两次点按最多隔多久（毫秒） */
const TAP_MS = 300;
/** 两次点按最多隔多远算双击（像素） */
const DOUBLE_SLOP = 28;
/** 松手时离 1 倍这么近就吸回 1 倍 */
const SNAP = 0.02;

/** 缩放倍数 s，图片中心相对取景框中心的位移 x、y */
export type ZoomView = { s: number; x: number; y: number };
/** 取景框和 1 倍时图片的大小 */
export type ZoomBox = { vw: number; vh: number; iw: number; ih: number };
type Pt = { x: number; y: number };

export const ZOOM_IDENTITY: ZoomView = { s: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 夹到合法范围：倍数 1～4；图比取景框小的方向居中，大的方向不许露出图外 */
export function clampView(v: ZoomView, b: ZoomBox): ZoomView {
  const s = clamp(v.s, ZOOM_MIN, ZOOM_MAX);
  const mx = Math.max((b.iw * s - b.vw) / 2, 0);
  const my = Math.max((b.ih * s - b.vh) / 2, 0);
  // + 0：把 -0 变成 0
  return { s, x: clamp(v.x, -mx, mx) + 0, y: clamp(v.y, -my, my) + 0 };
}

/** 从 from 缩放到 s，让 from 时在 at（相对取景框中心）下面的那一点移到 to（默认不动） */
export function zoomAround(from: ZoomView, s: number, at: Pt, b: ZoomBox, to: Pt = at): ZoomView {
  const next = clamp(s, ZOOM_MIN, ZOOM_MAX);
  const k = next / from.s;
  return clampView({ s: next, x: to.x - (at.x - from.x) * k, y: to.y - (at.y - from.y) * k }, b);
}

type Gesture = {
  /** 这次手势从哪、什么时候开始（第二根手指抬起后改成从剩下那根手指重新算） */
  start: Pt;
  at: number;
  from: ZoomView;
  primary: boolean;
  /** 这次手势出现过第二根手指：不再算点按和横滑 */
  multi: boolean;
  moved: boolean;
  pinch: { dist: number; mid: Pt; from: ZoomView } | null;
};

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function useZoomPan(resetKey: unknown, onSwipe: (dir: 1 | -1) => void) {
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const view = useRef<ZoomView>(ZOOM_IDENTITY);
  const pts = useRef(new Map<number, Pt>());
  const g = useRef<Gesture | null>(null);
  const lastTap = useRef<(Pt & { t: number }) | null>(null);
  const logged = useRef(false);

  const box = useCallback((): ZoomBox | null => {
    const f = frame.current;
    const img = layer.current?.querySelector('img');
    if (!f || !img || !img.offsetWidth || !img.offsetHeight) return null;
    return { vw: f.clientWidth, vh: f.clientHeight, iw: img.offsetWidth, ih: img.offsetHeight };
  }, []);

  const apply = useCallback((v: ZoomView, animate = false): void => {
    view.current = v;
    const el = layer.current;
    if (!el) return;
    if (animate && !prefersReducedMotion()) el.dataset['anim'] = '1';
    else delete el.dataset['anim'];
    el.style.transform = v.s === 1 ? '' : `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    el.dataset['zoomed'] = v.s > 1 ? '1' : '0';
  }, []);

  const logState = useCallback((): void => {
    const on = view.current.s > 1;
    if (on === logged.current) return;
    logged.current = on;
    rlog(on ? 'att view zoom in' : 'att view zoom out');
  }, []);

  // 换张：新图从 1 倍开始，手势作废
  useLayoutEffect(() => {
    pts.current.clear();
    g.current = null;
    lastTap.current = null;
    apply(ZOOM_IDENTITY);
    logState();
  }, [resetKey, apply, logState]);

  // 取景框变了（转屏、底部卡片出来）：重新夹一次，不留空边
  useEffect(() => {
    const f = frame.current;
    if (!f || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const b = box();
      if (b && view.current.s > 1) apply(clampView(view.current, b));
    });
    ro.observe(f);
    return () => ro.disconnect();
  }, [apply, box]);

  /** 相对取景框中心的坐标（取景框本身不变形） */
  const local = (p: Pt): Pt => {
    const r = frame.current?.getBoundingClientRect();
    return r ? { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 } : p;
  };

  const startPinch = (cur: Gesture): void => {
    const [a, b] = [...pts.current.values()];
    if (!a || !b) return;
    cur.multi = true;
    cur.pinch = { dist: Math.max(dist(a, b), 1), mid: local(mid(a, b)), from: view.current };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    // 换张按钮照常是按钮；鼠标只认左键；第三根手指不管
    if (e.button !== 0 || (e.target as Element).closest?.('button') || pts.current.size >= 2) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 指针已经没了：不用捕获 */
    }
    delete layer.current?.dataset['anim'];
    if (pts.current.size === 1) {
      g.current = { start: { x: e.clientX, y: e.clientY }, at: e.timeStamp, from: view.current, primary: e.isPrimary, multi: false, moved: false, pinch: null };
    } else if (g.current) startPinch(g.current);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const cur = g.current;
    if (!cur || !pts.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    pts.current.set(e.pointerId, p);
    if (dist(p, cur.start) > TAP_SLOP_PX) cur.moved = true;
    const b = box();
    if (!b) return;
    if (cur.pinch) {
      const [p1, p2] = [...pts.current.values()];
      if (!p1 || !p2) return;
      const { pinch } = cur;
      apply(zoomAround(pinch.from, (pinch.from.s * dist(p1, p2)) / pinch.dist, pinch.mid, b, local(mid(p1, p2))));
    } else if (cur.from.s > 1) {
      apply(clampView({ s: cur.from.s, x: cur.from.x + p.x - cur.start.x, y: cur.from.y + p.y - cur.start.y }, b));
    }
  };

  const settle = (): void => {
    const b = box();
    if (view.current.s <= ZOOM_MIN + SNAP) apply(ZOOM_IDENTITY);
    else if (b) apply(clampView(view.current, b));
    logState();
  };

  const tap = (e: ReactPointerEvent<HTMLElement>): void => {
    const p = { x: e.clientX, y: e.clientY };
    const last = lastTap.current;
    if (!last || e.timeStamp - last.t > TAP_MS || dist(p, last) > DOUBLE_SLOP) {
      lastTap.current = { ...p, t: e.timeStamp };
      return;
    }
    lastTap.current = null;
    const b = box();
    if (!b) return;
    apply(view.current.s > 1 ? ZOOM_IDENTITY : zoomAround(view.current, ZOOM_TAP, local(p), b), true);
    logState();
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const cur = g.current;
    if (!pts.current.delete(e.pointerId) || !cur) return;
    const left = [...pts.current.values()][0];
    if (left) {
      // 两指抬起一根：剩下那根从现在的位置接着拖
      cur.pinch = null;
      cur.start = left;
      cur.from = view.current;
      return;
    }
    g.current = null;
    settle();
    if (cur.multi || !cur.primary) return;
    const dx = e.clientX - cur.start.x;
    const dy = e.clientY - cur.start.y;
    const moved = cur.moved || Math.hypot(dx, dy) > TAP_SLOP_PX;
    if (!moved && e.timeStamp - cur.at <= TAP_MS) tap(e);
    else if (cur.from.s === 1 && Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!pts.current.delete(e.pointerId)) return;
    const left = [...pts.current.values()][0];
    if (left && g.current) {
      g.current.pinch = null;
      g.current.start = left;
      g.current.from = view.current;
      return;
    }
    g.current = null;
    settle();
  };

  return { frame, layer, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
