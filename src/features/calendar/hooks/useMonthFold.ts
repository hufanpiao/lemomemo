// 月历上拖收起（B2 FA-3 补，定稿线框 s3、架构 17、R-326）：月视图“往上拖，月历收成一周一行”
// • 锚点：选中那天所在的一行（没选中就是本月 1 日那一行）；收起后只留这一行，别的行淡出、inert
// • 手势交给 motion 的 useDragCollapse（跟手、可中断、松手按位置 / 速度吸附，减少动态效果时直接切换）；这里只量位置、算翻页
// • 只动 transform、opacity，布局不变：量一次“锚点那一行离格子顶多远”（top）和“日清单要上移多少才贴到锚点那一行下面”（shift）；
//   换月、换锚点、窗口变化时重量（收起状态下换锚点也要重量：各行高度不一样，只在展开时量会差出行高之差）。
//   位置一律沿 offsetParent 链累加到日清单那一块的 offsetParent（.page），见 layoutTop：
//   带 transform 的祖先会变成 offsetParent（Chrome），按钮翻页横滑、左右滑动时 .pager 带着 translateX，
//   直接拿 grid.offsetTop 会变成“相对 .pager”的值，少了 .pager 以上的那一截（设计第三轮复审 H1：多走 118 px 盖住星期行）
// • 收起后翻的是周：选中的那天前后挪 7 天，跨月时换月（useCalendar 的 pick，同一页内直接切换、不起整页过渡）；1900–2100 以外翻不动
// • “今天”按钮收起时：今天就在锚点那一行才算“在本周”（灰）
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { addDays, type DateStr } from '../../../../shared/core/date.ts';
import { MAX_YEAR, MIN_YEAR, monthOf } from '../../../../shared/logic/calendar/cal-nav.ts';
import { useDragCollapse } from '../../../motion/index.ts';
import type { useCalendar } from './useCalendar.ts';

/** 收起后按周翻：从 base 挪 n 周，超出 1900–2100 时 null */
export function stepWeek(base: DateStr, n: -1 | 1): DateStr | null {
  const d = addDays(base, 7 * n);
  const y = Number(d.slice(0, 4));
  return y < MIN_YEAR || y > MAX_YEAR ? null : d;
}

/**
 * el 在 root 里的布局位置（px，不含任何 transform）：沿 offsetParent 链把 offsetTop 一路加上去，直到 root。
 * 中途有祖先带 transform、变成了 offsetParent 也不影响结果；链上碰不到 root 时加到顶为止
 */
export function layoutTop(el: HTMLElement, root: Element | null): number {
  let y = 0;
  let e: Element | null = el;
  while (e instanceof HTMLElement && e !== root) {
    y += e.offsetTop;
    e = e.offsetParent;
  }
  return y;
}

type Cal = ReturnType<typeof useCalendar>;

export function useMonthFold(cal: Cal, selected: DateStr | null, setPicked: Dispatch<SetStateAction<DateStr | null>>) {
  const { model } = cal;
  const [collapsed, setCollapsed] = useState(false);
  const cells = model.view.mode === 'month' ? model.cells : null;
  /** 月视图、格子算出来了：有拖动柄 */
  const active = cells !== null;
  const rowOf = (d: DateStr | null): number => {
    const i = d === null || !cells ? -1 : cells.findIndex((c) => c.inMonth && c.date === d);
    return i < 0 ? -1 : Math.floor(i / 7);
  };
  const anchor = selected ?? cells?.find((c) => c.inMonth)?.date ?? null;
  const row = Math.max(0, rowOf(anchor));
  /** 现在是收起状态（‹ ›、← →、滑动按周翻） */
  const byWeek = active && collapsed;

  const gridRef = useRef<HTMLDivElement>(null);
  const dayRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ top: 0, shift: 0 });
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    const on = (): void => setResizeTick((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useLayoutEffect(() => {
    const g = gridRef.current;
    const d = dayRef.current;
    if (!g || !d) return;
    const cell = g.children[row * 7];
    const top = cell instanceof HTMLElement ? cell.offsetTop : 0;
    const h = cell instanceof HTMLElement ? cell.offsetHeight : 0;
    const shift = Math.max(0, d.offsetTop - layoutTop(g, d.offsetParent) - h);
    setGeo((o) => (o.top === top && o.shift === shift ? o : { top, shift }));
  }, [row, cells, model.wide, model.holidaysOffline, resizeTick]);

  const drag = useDragCollapse(collapsed, setCollapsed, () => geo.shift);
  const p = active ? drag.progress : 0;
  // 日清单那一块：收起途中只动 transform；收起停稳以后再用负的下边距收掉页面底部空出来的那一段（一次性改布局，不做动画）
  const settled = byWeek && p === 1 && !drag.moving;
  const dayStyle: CSSProperties | undefined = p > 0 ? { transform: `translateY(${-geo.shift * p}px)`, ...(settled ? { marginBottom: -geo.shift } : {}) } : undefined;

  /** 收起时按周翻一下；翻不动返回 false */
  const step = (n: -1 | 1): boolean => {
    if (anchor === null) return false;
    const d = stepWeek(anchor, n);
    if (d === null) return false;
    setPicked(d);
    const ym = monthOf(d);
    if (ym.y !== model.header.y || ym.m !== model.header.m) cal.pick(ym);
    return true;
  };

  return {
    active,
    collapsed,
    byWeek,
    row,
    /** 进度：0 展开、1 收起 */
    p,
    geo,
    /** 日清单那一块（拖动柄 + 清单）的 style */
    dayStyle,
    gridRef,
    dayRef,
    drag,
    step,
    isCurrent: byWeek ? model.isCurrent && rowOf(model.today) === row : model.isCurrent,
    canPrev: byWeek ? anchor !== null && stepWeek(anchor, -1) !== null : model.canPrev,
    canNext: byWeek ? anchor !== null && stepWeek(anchor, 1) !== null : model.canNext,
  };
}
