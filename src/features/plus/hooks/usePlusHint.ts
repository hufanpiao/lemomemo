// “＋”上方的小气泡（B3 S23，见 ../data/plus-hint.ts）：这次启动要不要出、出在哪
// • exe 不出（R-90：exe 不做语音）；开关 PLUS_HINT_ENABLED 关着时不出、也不记次数
// • 位置跟着“＋”（底栏 kit/components/GlassBar 的 data-testid="tabbar-add"）：只读它的位置，不改底栏；
//   “＋”不在（没有底栏的页）、被藏起（键盘弹起时根节点 data-kbhide，platform/viewport.ts）、尺寸为 0 时不出
// • 底栏换页、键盘起落、窗口变化时重新量：听 resize、hashchange，并看根节点下的增删和 data-kbhide 变化（合并到 100 ms 量一次）；
//   量出来和上次一样就不更新状态，不白白重画（S23 代码审建议 1）
// • 本机库还没准备好（例如还在登录页）或读写出错：这次不出，换页（hashchange）时再查一次（建议 3、复审 R1）
// • 按住过一次（markPlusHeld）：当场收起（建议 3）
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { BAR_HIDE_ATTR } from '../../../platform/viewport.ts';
import { PLUS_HINT_ENABLED, plusHeldNow, plusHintThisLaunch, watchPlusHeld } from '../data/plus-hint.ts';

export interface HintSpot {
  /** 气泡右边到视口右边的距离（px），和“＋”右边对齐 */
  right: number;
  /** 气泡底边到视口底边的距离（px），在“＋”上方留 10px */
  bottom: number;
}

export const PLUS_SELECTOR = '[data-testid="tabbar-add"]';

const sameSpot = (a: HintSpot | null, b: HintSpot | null): boolean => a === b || (a !== null && b !== null && a.right === b.right && a.bottom === b.bottom);

/** “＋”的位置 → 气泡放哪；看不见时 null */
export function spotOf(fab: Element | null, vw: number, vh: number): HintSpot | null {
  if (!fab || fab.ownerDocument.documentElement.hasAttribute(BAR_HIDE_ATTR)) return null;
  const r = fab.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { right: Math.round(vw - r.right), bottom: Math.round(vh - r.top + 10) };
}

export function usePlusHint(enabled: boolean = PLUS_HINT_ENABLED, exe: boolean = isTauri()): HintSpot | null {
  const [show, setShow] = useState(false);
  const [spot, setSpot] = useState<HintSpot | null>(null);
  const last = useRef<HintSpot | null>(null);
  const held = useSyncExternalStore(watchPlusHeld, plusHeldNow, plusHeldNow);

  useEffect(() => {
    if (!enabled || exe) return undefined;
    let live = true;
    const check = (): void => {
      void plusHintThisLaunch(clock.now()).then((v) => {
        if (!live) return;
        if (v === null) return; // 本机库还没准备好或读写出错：等下次换页再查
        window.removeEventListener('hashchange', check);
        setShow(v);
      });
    };
    window.addEventListener('hashchange', check);
    check();
    return () => {
      live = false;
      window.removeEventListener('hashchange', check);
    };
  }, [enabled, exe]);

  useEffect(() => {
    if (!show || held) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = (): void => {
      timer = null;
      const next = spotOf(document.querySelector(PLUS_SELECTOR), window.innerWidth, window.innerHeight);
      // 和上次一样就不 setState
      if (sameSpot(last.current, next)) return;
      last.current = next;
      setSpot(next);
    };
    const soon = (): void => {
      timer ??= setTimeout(measure, 100);
    };
    measure();
    window.addEventListener('resize', soon);
    window.addEventListener('hashchange', soon);
    const mo = new MutationObserver(soon);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [BAR_HIDE_ATTR] });
    return () => {
      window.removeEventListener('resize', soon);
      window.removeEventListener('hashchange', soon);
      mo.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [show, held]);

  return show && !held ? spot : null;
}
