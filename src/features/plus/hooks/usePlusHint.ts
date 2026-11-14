// “＋”上方的小气泡（B3 S23，见 ../data/plus-hint.ts）：这次启动要不要出、出在哪
// • exe 不出（R-90：exe 不做语音）；开关 PLUS_HINT_ENABLED 关着时不出、也不记次数
// • 位置跟着“＋”（底栏 kit/components/GlassBar 的 data-testid="tabbar-add"）：只读它的位置，不改底栏；放在“＋”上方、三角朝下
// • 电脑宽度（MQ_SIDEBAR，“＋”在左边侧栏顶上）不出、也不记次数（B4b-3，按定稿线框 R-126 方案 B：侧栏的 .rhint 是 display:none，
//   电脑版第一次使用只有符号说明卡；B6 返工时放在“＋”右边，盖住纪念日胶囊和随手记面板标题，推进计划第二节第 8 条）。
//   开着时拉宽到电脑宽度：当场收起；换页（hashchange）时再查一次，窄下来照常出
//   “＋”不在（没有底栏的页）、被藏起（算出来的 visibility 是 hidden：窄屏键盘弹起时 GlassBar 按根节点 data-kbhide 藏，宽屏不藏；
//   和 GlassBarFx.tsx 替底栏代点时一样看算出来的样式，不只看属性，11-12 台账 Q-20）、尺寸为 0 时不出
// • 底栏换页、键盘起落、窗口变化时重新量：听 resize、hashchange，并看根节点下的增删和 data-kbhide 变化（合并到 100 ms 量一次）；
//   量出来和上次一样就不更新状态，不白白重画（S23 代码审建议 1）
// • 本机库还没准备好（例如还在登录页）或读写出错：这次不出，换页（hashchange）时再查一次（建议 3、复审 R1）
// • 按住过一次（markPlusHeld）：当场收起（建议 3）
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clock } from '../../../platform/clock.ts';
import { MQ_SIDEBAR } from '../../../kit/hooks/useMedia.ts';
import { isTauri } from '../../../platform/env.ts';
import { BAR_HIDE_ATTR } from '../../../platform/viewport-geom.ts';
import { PLUS_HINT_ENABLED, plusHeldNow, plusHintThisLaunch, watchPlusHeld } from '../data/plus-hint.ts';

/** right 是气泡右边到视口右边的距离（和“＋”右边对齐），bottom 是气泡底边到视口底边的距离（在“＋”上方留 10px） */
export interface HintSpot { side: 'above'; right: number; bottom: number }

export const PLUS_SELECTOR = '[data-testid="tabbar-add"]';

const sameSpot = (a: HintSpot | null, b: HintSpot | null): boolean => a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/** 电脑宽度：“＋”在左边侧栏里，不出气泡（见文件头） */
const isDesk = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(MQ_SIDEBAR).matches;

/** “＋”的位置 → 气泡放哪；看不见时 null */
export function spotOf(fab: Element | null, vw: number, vh: number): HintSpot | null {
  if (!fab || getComputedStyle(fab).visibility === 'hidden') return null;
  const r = fab.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { side: 'above', right: Math.round(vw - r.right), bottom: Math.round(vh - r.top + 10) };
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
      if (isDesk()) return; // 电脑宽度不出、不记次数；换页时再查
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
      const next = isDesk() ? null : spotOf(document.querySelector(PLUS_SELECTOR), window.innerWidth, window.innerHeight);
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
