// 月历上拖收起（B2 FA-3 补，定稿线框 s3、架构 17、R-326；R-457 负责人 11-17 选“C 压扁收起”）：月视图“往上拖，月历收成一周一行”
// • 锚点：选中那天所在的一行（没选中就是本月 1 日那一行）
// • 手势交给 motion 的 useDragCollapse（跟手、可中断、松手按位置 / 速度用项目弹簧吸附，减少动态效果时直接切换）
// • 两种排布，只在“开始动”“停稳”这两次重画时换（两次换的前后画面一模一样）：
//   ① 停在收起：真的只排锚点那一行（MonthGrid 的 folded，别的行 display: none），日清单就在它下面，不靠位移、不靠负外边距；
//   ② 其余时候：六行照常排；动画途中按进度直接写 DOM（paintFold，不经 React、不重画）：
//      别的行原地压扁（scaleY，从上沿压）、字先淡掉，锚点那一行被上面压扁的行带着上去；.gridClip 从下沿裁掉（clip-path）；
//      日清单那一块整块上移同样的距离（月历六行高 − 锚点那一行高），停稳时正好是 ① 的位置。
//   R-457 负责人真机“收缩放大下面的待办跟不上节奏”的根因（运行日志 cal fold … todo_drift=484 todo_tf=16/16，webkit）：
//   旧写法每一帧都把进度放进 React state、整页重画，日清单的位移写在 style 上，列表里 Motion 的 layout 每一帧都以为待办组位置变了、
//   自己补一段平移，于是总比日程行慢一拍。现在动画途中不重画，Motion 不量；起止两次重画前后画面一样，量出来也没变化
// • 位置在“开始动”那一次（换成 ② 排布以后、画出来以前，useLayoutEffect）现量：各行相对月格的位置和高度，没有任何 transform
// • 运行日志：停稳时“cal fold open→folded via=drag|tap ms= todo_drift= todo_tf=”（useFoldSync 在开始动、停稳两刻量待办组跟没跟上日清单）
// • 收起后翻的是周：选中的那天前后挪 7 天，跨月时换月（useCalendar 的 pick，同一页内直接切换、不起整页过渡）；1900–2100 以外翻不动
// • “今天”按钮收起时：今天就在锚点那一行才算“在本周”（灰）
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { addDays, type DateStr } from '../../../../shared/core/date.ts';
import { MAX_YEAR, MIN_YEAR, monthOf } from '../../../../shared/logic/calendar/cal-nav.ts';
import { useDragCollapse } from '../../../motion/gestures.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { useCalendar } from './useCalendar.ts';

/** 收起后按周翻：从 base 挪 n 周，超出 1900–2100 时 null */
export function stepWeek(base: DateStr, n: -1 | 1): DateStr | null {
  const d = addDays(base, 7 * n);
  const y = Number(d.slice(0, 4));
  return y < MIN_YEAR || y > MAX_YEAR ? null : d;
}

/** 量出来的位置：各行（第一格）相对月格的位置和高度、月格六行的总高（px，不含 transform） */
export interface FoldGeo {
  readonly rows: readonly { readonly top: number; readonly h: number }[];
  readonly full: number;
}

/** 别的行压扁到这么小（scaleY 不能是 0：0 时变换矩阵不可逆，浏览器会把整格的命中区、读屏位置算乱） */
const FLAT = 0.0001;
/** 别的行的字比压扁淡得快：压到一半前就淡没了（方案页 C 的写法） */
const FADE_RATE = 2.2;

/** 进度 p 时：第 r 行的 transform 和透明度（锚点那一行不淡），月格从下沿裁掉多少、日清单上移多少（两者相同） */
export function foldFrame(g: FoldGeo, a: number, p: number): { row(r: number): { transform: string; opacity: string } | null; cut: number } {
  if (p <= 0) return { row: () => null, cut: 0 };
  /** 第 r 行往上走多少：它上面各行（锚点那一行除外）的行距（含格缝）× p */
  const lift = (r: number): number => {
    let s = 0;
    for (let j = 0; j < r; j += 1) if (j !== a) s += (g.rows[j + 1]?.top ?? g.full) - (g.rows[j]?.top ?? 0);
    return s * p;
  };
  return {
    row: (r) =>
      r === a
        ? { transform: `translateY(${-lift(r)}px)`, opacity: '' }
        : { transform: `translateY(${-lift(r)}px) scaleY(${Math.max(FLAT, 1 - p)})`, opacity: String(Math.max(0, 1 - p * FADE_RATE)) },
    cut: (g.full - (g.rows[a]?.h ?? 0)) * p,
  };
}

/** 量月格：每一行第一格相对月格的位置和高度（同一行七格一样高：月格是 subgrid） */
function measure(grid: HTMLElement): FoldGeo {
  const top0 = grid.getBoundingClientRect().top;
  const rows: { top: number; h: number }[] = [];
  for (let i = 0; i < grid.children.length; i += 7) {
    const r = grid.children[i]?.getBoundingClientRect();
    if (r) rows.push({ top: r.top - top0, h: r.height });
  }
  return { rows, full: grid.getBoundingClientRect().height };
}

/** 按进度把收起画到 DOM 上（p 为 0 时全部清掉）；只写 transform、opacity、clip-path */
function paintFold(grid: HTMLElement, day: HTMLElement | null, g: FoldGeo, a: number, p: number): void {
  const f = foldFrame(g, a, p);
  for (let i = 0; i < grid.children.length; i += 1) {
    const el = grid.children[i];
    if (!(el instanceof HTMLElement)) continue;
    const s = f.row(Math.floor(i / 7));
    el.style.transform = s?.transform ?? '';
    el.style.transformOrigin = s && s.opacity !== '' ? '50% 0' : '';
    el.style.opacity = s?.opacity ?? '';
  }
  // 裁到锚点那一行下面再留一道格缝（聚焦框），别的行压扁后都在这一道缝里，看不见
  const clip = grid.parentElement;
  // 左右放出多少读 .gridClip 的 --clip-x（MonthGrid.module.css，只写那一处）
  if (clip) clip.style.clipPath = f.cut > 0 ? `inset(0 var(--clip-x) calc(${f.cut}px - var(--cal-gap)))` : '';
  if (day) day.style.transform = f.cut > 0 ? `translateY(${-f.cut}px)` : '';
}

/**
 * 收起、展开时日清单里各块是不是一起走（R-457 负责人真机“收缩放大下面的待办跟不上节奏”）：
 * 量待办组（cal-todos）相对日清单那一块的位置，停稳那一刻和开始动那一刻比，记下偏差（todo_drift，px）；
 * 再数这两次里有几次待办组自己身上带着 transform（todo_tf=带的次数/量的次数：Motion 的 layout 动画补位置时会写它）。只记位置和次数，不记内容
 * 11-20 起只在开始动、停稳这两刻各量一次（全 app 改善报告第四节）：原来动画途中每一帧都量（每帧两次强制排版，正好在最怕掉帧的时候）；
 * R-457 根因改掉以后（动画途中不重画）待办组跟日清单是同一个 transform 带着走，首尾一比就看得出跟没跟上
 */
interface FoldSync {
  base: number;
  drift: number;
  tf: number;
  n: number;
}
const newSync = (): FoldSync => ({ base: Number.NaN, drift: 0, tf: 0, n: 0 });
const TODOS_SEL = '[data-testid="cal-todos"]';

/** 量一次（开始动、停稳各调一次） */
function sampleSync(s: FoldSync, d: HTMLElement | null): void {
  const g = d?.querySelector<HTMLElement>(TODOS_SEL);
  if (!d || !g) return;
  const off = g.getBoundingClientRect().top - d.getBoundingClientRect().top;
  if (Number.isNaN(s.base)) s.base = off;
  s.drift = Math.max(s.drift, Math.abs(off - s.base));
  const tf = g.style.transform;
  if (tf !== '' && tf !== 'none') s.tf += 1;
  s.n += 1;
}
/** 停稳那一刻（拖动收起的 log 回调里，这一帧刚按最终进度画完）再量一次，拼进运行日志那一行 */
const syncText = (s: FoldSync, d: HTMLElement | null): string => {
  sampleSync(s, d);
  return `todo_drift=${Math.round(s.drift)} todo_tf=${s.tf}/${s.n}`;
};

function useFoldSync(moving: boolean, dayRef: RefObject<HTMLDivElement | null>, sync: MutableRefObject<FoldSync>): void {
  useEffect(() => {
    if (!moving) return;
    // 开始动那一刻（换成六行排布、按此刻进度画好以后）量起点
    const s = newSync();
    sync.current = s;
    sampleSync(s, dayRef.current);
  }, [moving, dayRef, sync]);
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
  const geo = useRef<FoldGeo>({ rows: [], full: 0 });
  const rowRef = useRef(row);
  rowRef.current = row;
  const paint = (p: number): void => {
    if (gridRef.current) paintFold(gridRef.current, dayRef.current, geo.current, rowRef.current, p);
  };

  const sync = useRef<FoldSync>(newSync());
  const drag = useDragCollapse(collapsed, setCollapsed, () => geo.current.full - (geo.current.rows[rowRef.current]?.h ?? 0), {
    onFrame: paint,
    log: (line) => rlog(`cal ${line} ${syncText(sync.current, dayRef.current)}`),
  });
  useFoldSync(drag.moving, dayRef, sync);
  /** 停在收起：真的只排锚点那一行（见文件头 ①） */
  const folded = byWeek && !drag.moving && drag.rest === 1;

  // 换排布、换锚点、换月以后，画出来以前：① 清掉；② 现量位置（先清掉再量，量的是没有 transform 的排布），再按此刻的进度画上
  useLayoutEffect(() => {
    const g = gridRef.current;
    if (!g) return;
    paintFold(g, dayRef.current, geo.current, row, 0);
    if (folded) return;
    geo.current = measure(g);
    paintFold(g, dayRef.current, geo.current, row, active ? drag.progress : 0);
    // drag.progress 读的是此刻的值，不随它重画；只在开始动、停稳、换锚点、换月、换宽窄时重量一次（开始动时量，窗口变过也是新的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded, drag.moving, row, cells, active, model.wide, model.holidaysOffline]);

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
    /** 停在收起：月格只排锚点那一行 */
    folded,
    gridRef,
    dayRef,
    drag,
    step,
    isCurrent: byWeek ? model.isCurrent && rowOf(model.today) === row : model.isCurrent,
    canPrev: byWeek ? anchor !== null && stepWeek(anchor, -1) !== null : model.canPrev,
    canNext: byWeek ? anchor !== null && stepWeek(anchor, 1) !== null : model.canNext,
  };
}
