// 下拉露出搜索框（R-437；同 iPhone 备忘录）：随手记、待办、日历三页共用这一个 hook，搜索框和结果在 smart-search 的 PullSearch
// • 手机：页面滚到顶（window.scrollY ≤ 0）时按下，再往下拉过 PULL_OPEN_PX、竖着拉为主（横向不超过竖向一半）就露出。
//   用 touch 事件（passive）：滚到顶以后往下拉，浏览器自己接手回弹，pointer 事件会被 pointercancel 掉，touch 事件照常来
// • 电脑：滚到顶以后滚轮继续往上滚，累计过 WHEEL_OPEN_PX 就露出；刚滚到顶的 SETTLE_MS 内不算（触控板惯性滚到顶不误开）
// • 只认按在 region（页面 main）里的：弹层是挂在 body 上的，不在 region 里；按在 [data-nopull] 里的不算（日历日清单的拖动柄本身就是上下拖）
// • 露出以后一直留着，直到 close()（搜索框的“取消”：清空并收起）；q 放在这里，页面按 searching 把本页列表换成结果
// • 运行日志：pull open <页> via=touch|wheel、pull close <页>（不记打的字）
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { rlog } from '../../platform/run-log-api.ts';

/** 往下拉多少露出（px） */
export const PULL_OPEN_PX = 64;
/** 滚轮在顶上继续往上滚多少露出（px） */
export const WHEEL_OPEN_PX = 120;
/** 两次滚轮隔这么久就从头累计 */
const WHEEL_GAP_MS = 250;
/** 刚滚到顶的这段时间里滚轮不算（惯性） */
export const SETTLE_MS = 300;
/** 滚轮按行滚时一行算多少 px */
const LINE_PX = 16;

export type PullVia = 'touch' | 'wheel';

export interface PullReveal {
  open: boolean;
  q: string;
  setQ(q: string): void;
  /** 打了字（去掉空白不为空）：页面把本页列表换成结果 */
  searching: boolean;
  reveal(via: PullVia): void;
  /** 清空并收起 */
  close(): void;
}

const atTop = (): boolean => window.scrollY <= 0;
const inRegion = (region: HTMLElement | null, t: EventTarget | null): boolean =>
  region !== null && t instanceof Element && region.contains(t) && t.closest('[data-nopull]') === null;

/** tag：页名，只进运行日志；enabled 为 false（隐私记页）时不接手势 */
export function usePullReveal(region: RefObject<HTMLElement | null>, tag: string, enabled = true): PullReveal {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // open 只经 reveal、close 改，这一份跟着它们改（不在渲染时写 ref）
  const openRef = useRef(false);

  const reveal = useCallback((via: PullVia) => {
    if (openRef.current) return;
    openRef.current = true;
    setOpen(true);
    rlog(`pull open ${tag} via=${via}`);
  }, [tag]);
  const close = useCallback(() => {
    setQ('');
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    rlog(`pull close ${tag}`);
  }, [tag]);

  useEffect(() => {
    if (!enabled || open) return undefined;
    let start: { x: number; y: number } | null = null;
    let acc = 0;
    let last = 0;
    // 打开页面时就在顶上：不算“刚滚到顶”
    let topSince = -Infinity;
    let wasTop = atTop();
    const onScroll = (): void => {
      const top = atTop();
      if (top && !wasTop) topSince = performance.now();
      wasTop = top;
    };
    const onStart = (e: TouchEvent): void => {
      const p = e.touches[0];
      start = e.touches.length === 1 && p && atTop() && inRegion(region.current, e.target) ? { x: p.clientX, y: p.clientY } : null;
    };
    const onMove = (e: TouchEvent): void => {
      const p = e.touches[0];
      if (!start || !p) return;
      if (!atTop()) {
        start = null;
        return;
      }
      const dy = p.clientY - start.y;
      if (dy >= PULL_OPEN_PX && Math.abs(p.clientX - start.x) * 2 < dy) {
        start = null;
        reveal('touch');
      }
    };
    const onEnd = (): void => {
      start = null;
    };
    const onWheel = (e: WheelEvent): void => {
      const now = performance.now();
      if (e.deltaY >= 0 || !atTop() || !inRegion(region.current, e.target) || now - topSince < SETTLE_MS) {
        acc = 0;
        return;
      }
      if (now - last > WHEEL_GAP_MS) acc = 0;
      last = now;
      acc += -e.deltaY * (e.deltaMode === 1 ? LINE_PX : 1);
      if (acc >= WHEEL_OPEN_PX) {
        acc = 0;
        reveal('wheel');
      }
    };
    const o = { passive: true } as const;
    window.addEventListener('scroll', onScroll, o);
    window.addEventListener('touchstart', onStart, o);
    window.addEventListener('touchmove', onMove, o);
    window.addEventListener('touchend', onEnd, o);
    window.addEventListener('touchcancel', onEnd, o);
    window.addEventListener('wheel', onWheel, o);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('wheel', onWheel);
    };
  }, [enabled, open, region, reveal]);

  return { open, q, setQ, searching: q.trim() !== '', reveal, close };
}
