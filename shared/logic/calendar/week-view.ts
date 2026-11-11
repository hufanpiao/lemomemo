// 周视图的数据和布局（架构 5.12 第 2 点、R-107、R-109、R-110；第 9 节“buildWeek 布局”；TC-B2-09）
// buildWeek(weekStart, items, opts)：weekStart 是这一周的第一天，返回 7 天，每天：
// • 全天日程不上时间轴，记成“全天 N”（N = 1 时带简称）；
// • 有时刻的日程按设备时区换算，跨午夜的在午夜切成两段，各归各天，cont 标出被切的一边（'end' = 尾部被切，
//   'start' = 头部被切，'both' = 两头都被切），界面在被切的一端画成直边；
// • 手机（layout 'phone'，时间轴横向）：色块长度取 max(按时长算的长度, minBlockPx)，超出当天末尾的截到末尾，
//   截完不够最小长度的右端对齐当天末尾、往左补足；显示区间有交叠的归一组，组内上排空着放上排（row 0），
//   否则下排空着放下排（row 1），两排都占着的不画、记进这一组的 more；组里有两排时 rows = 2，否则 1；
// • 电脑（layout 'desk'，时间轴纵向，相当于 minBlockPx = 0）：按真实时长画，重叠的并排分列，块带 column、columns。
// • 待办（和前端 A 对过的接口）：规则和月历一样（todoDate：删掉的、撤销的、已完成的、没有截止日的不放，截止日是浮动日期不换算），
//   手机放进当天的 todos（kind 'todo'，泳道上画空心圆），电脑并进 allDay 那一行（排在全天日程后面）。纯函数。
import { addDays, minOfDay, msAt, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import { isLiveRow } from '../live-row.ts';
import type { ProjectColor } from '../project-color.ts';
import {
  assertTz,
  compareEntries,
  eventEntry,
  nearRange,
  placeEvent,
  todoDate,
  todoEntry,
  TZ_SPILL_DAYS,
  type CalEvent,
  type CalTodo,
  type DayEntry,
} from './cal-items.ts';
import { weekDates } from './cal-nav.ts';

const DAY_MIN = 1440;

/** 被午夜切开的一边 */
export type Cont = 'start' | 'end' | 'both';

/** 一天里的一段（跨午夜的日程切开以后各段分别算） */
interface Segment {
  readonly entry: DayEntry;
  readonly startMin: number;
  readonly endMin: number;
  readonly cont?: Cont;
}

interface BlockBase {
  readonly itemId: string;
  readonly colorIndex: ProjectColor;
  readonly short: string;
  /** 当天第几分钟开始、结束（结束可以是 1440 = 到当天末尾） */
  readonly startMin: number;
  readonly endMin: number;
  readonly cont?: Cont;
}

export interface PhoneBlock extends BlockBase {
  readonly startPx: number;
  readonly widthPx: number;
  readonly row: 0 | 1;
  readonly rows: 1 | 2;
}

/** 手机上的一组（显示区间连着交叠的块）；more > 0 时在 moreAtPx 处写“+N” */
export interface PhoneGroup {
  readonly moreAtPx: number;
  readonly more: number;
  /** 没画出来的那几件（more 件）的 itemId，按开始时刻排；点“+N”时界面可以直接列出来 */
  readonly hiddenIds: readonly string[];
}

export interface DeskBlock extends BlockBase {
  readonly column: number;
  readonly columns: number;
}

/** 全天事项：count 件；只有 1 件时 short 是它的简称，否则 null（电脑上待办也算在这一行里） */
export interface AllDay {
  readonly count: number;
  readonly short: string | null;
  readonly itemIds: readonly string[];
  /** 和 itemIds 一一对应：'allDay' 是全天日程（events 表），'todo' 是待办（todos 表，画空心圆）。代码审查 S9 */
  readonly kinds: readonly DayEntry['kind'][];
}

export interface PhoneDay {
  readonly date: DateStr;
  readonly allDay: AllDay;
  /** 截止日是这一天的待办（kind 'todo'，按 compareEntries 排）；泳道上画空心圆 */
  readonly todos: readonly DayEntry[];
  readonly blocks: readonly PhoneBlock[];
  readonly groups: readonly PhoneGroup[];
}

export interface DeskDay {
  readonly date: DateStr;
  readonly allDay: AllDay;
  readonly blocks: readonly DeskBlock[];
}

export interface PhoneWeekOpts {
  readonly layout: 'phone';
  /** 设备当前时区 */
  readonly tz: Tz;
  /** 色块最小长度（约 28 px，以视觉稿为准） */
  readonly minBlockPx: number;
  /**
   * 一天那一行时间轴的实际宽度（px）：由界面量出来传进来（ResizeObserver 等量到的那一行的内容宽度），
   * 不是固定值；0:00 在 0、24:00 在 dayPx。窗口宽度变了要用新的值重算
   */
  readonly dayPx: number;
}

export interface DeskWeekOpts {
  readonly layout: 'desk';
  readonly tz: Tz;
}

/** 和月历的 CalItems 同名同类型，调用方可以直接传同一个对象 */
export interface WeekItems {
  readonly events: readonly CalEvent[];
  readonly todos: readonly CalTodo[];
}

function contOf(i: number, n: number): Cont | undefined {
  if (n <= 1) return undefined;
  if (i === 0) return 'end';
  if (i === n - 1) return 'start';
  return 'both';
}

/** 有时刻的日程按设备时区在午夜切段，返回 [日期, 段] */
function splitAtMidnight(entry: DayEntry, date: DateStr, startMs: number, endMs: number, tz: Tz): [DateStr, Segment][] {
  const parts: [DateStr, number, number][] = [];
  let day = date;
  let from = startMs;
  // duration_min ≤ 1440，最多跨两天；上限 3 段只是防御
  while (from < endMs && parts.length < 3) {
    const next = addDays(day, 1);
    const dayEnd = msAt(next, 0, tz);
    const to = Math.min(endMs, dayEnd);
    const startMin = parts.length === 0 ? minOfDay(from, tz) : 0;
    const endMin = to === dayEnd ? DAY_MIN : Math.max(startMin, minOfDay(to, tz));
    parts.push([day, startMin, endMin]);
    day = next;
    from = dayEnd;
  }
  return parts.map(([d, startMin, endMin], i) => {
    const cont = contOf(i, parts.length);
    return [d, { entry, startMin, endMin, ...(cont === undefined ? {} : { cont }) }];
  });
}

interface DayBuckets {
  readonly allDay: Map<DateStr, DayEntry[]>;
  readonly timed: Map<DateStr, Segment[]>;
  readonly todos: Map<DateStr, DayEntry[]>;
}

function bucket(dates: readonly DateStr[], items: WeekItems, tz: Tz): DayBuckets {
  const allDay = new Map<DateStr, DayEntry[]>(dates.map((d) => [d, []]));
  const timed = new Map<DateStr, Segment[]>(dates.map((d) => [d, []]));
  const todos = new Map<DateStr, DayEntry[]>(dates.map((d) => [d, []]));
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) return { allDay, timed, todos };
  for (const ev of items.events) {
    // 预筛（代码审查 A）：除了换算时区可能差的天数，前面再多留 1 天——前一天开始、跨午夜进到这一周的那一段也要算
    if (!isLiveRow(ev) || !nearRange(ev.date, first, last, TZ_SPILL_DAYS + 1, TZ_SPILL_DAYS)) continue;
    const p = placeEvent(ev, tz);
    if (!p) continue;
    const entry = eventEntry(ev, p);
    if (p.allDay) {
      allDay.get(p.date)?.push(entry);
      continue;
    }
    for (const [d, seg] of splitAtMidnight(entry, todayOf(p.startMs, tz), p.startMs, p.endMs, tz)) timed.get(d)?.push(seg);
  }
  for (const td of items.todos) {
    const d = todoDate(td);
    if (d !== null) todos.get(d)?.push(todoEntry(td));
  }
  return { allDay, timed, todos };
}

function allDayOf(entries: DayEntry[]): AllDay {
  const sorted = entries.sort(compareEntries);
  const only = sorted.length === 1 ? sorted[0] : undefined;
  return { count: sorted.length, short: only ? only.short : null, itemIds: sorted.map((e) => e.itemId), kinds: sorted.map((e) => e.kind) };
}

/** 段的排序：开始分钟，再按创建时间、id（结果稳定） */
function compareSegments(a: Segment, b: Segment): number {
  return a.startMin - b.startMin || compareEntries(a.entry, b.entry);
}

function base(s: Segment): BlockBase {
  return {
    itemId: s.entry.itemId,
    colorIndex: s.entry.colorIndex,
    short: s.entry.short,
    startMin: s.startMin,
    endMin: s.endMin,
    ...(s.cont === undefined ? {} : { cont: s.cont }),
  };
}

/**
 * 按开始排好序的块分成“连着交叠”的几组：后一块的起点落在这一组已占的区间里（严格小于，首尾相接不算交叠）就并进去。
 * 只用 for…of，不按下标取（check_backend F7）
 */
function clusters<T>(sorted: readonly T[], startOf: (x: T) => number, endOf: (x: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let end = -Infinity;
  for (const x of sorted) {
    if (cur.length > 0 && startOf(x) >= end) {
      out.push(cur);
      cur = [];
      end = -Infinity;
    }
    cur.push(x);
    end = Math.max(end, endOf(x));
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 手机：按显示区间分组、上下两排（R-109、R-110） */
function layoutPhone(segs: readonly Segment[], minPx: number, dayPx: number): { blocks: PhoneBlock[]; groups: PhoneGroup[] } {
  const scale = dayPx / DAY_MIN;
  const placed = segs.map((s) => {
    let startPx = s.startMin * scale;
    let widthPx = Math.max((s.endMin - s.startMin) * scale, minPx);
    if (startPx + widthPx > dayPx) {
      widthPx = dayPx - startPx;
      if (widthPx < minPx) {
        startPx = Math.max(0, dayPx - minPx);
        widthPx = dayPx - startPx;
      }
    }
    return { s, startPx, widthPx };
  });
  const blocks: PhoneBlock[] = [];
  const groups: PhoneGroup[] = [];
  for (const members of clusters(placed, (p) => p.startPx, (p) => p.startPx + p.widthPx)) {
    // 两排各自最后一块的右端（不用数组下标，F7）
    let row0End = -Infinity;
    let row1End = -Infinity;
    const visible: { p: (typeof placed)[number]; row: 0 | 1 }[] = [];
    const hiddenIds: string[] = [];
    for (const p of members) {
      const right = p.startPx + p.widthPx;
      if (p.startPx >= row0End) {
        row0End = right;
        visible.push({ p, row: 0 });
      } else if (p.startPx >= row1End) {
        row1End = right;
        visible.push({ p, row: 1 });
      } else {
        hiddenIds.push(p.s.entry.itemId);
      }
    }
    const rows: 1 | 2 = visible.some((v) => v.row === 1) ? 2 : 1;
    for (const { p, row } of visible) blocks.push({ ...base(p.s), startPx: p.startPx, widthPx: p.widthPx, row, rows });
    groups.push({ moreAtPx: Math.max(...visible.map((v) => v.p.startPx + v.p.widthPx)), more: hiddenIds.length, hiddenIds });
  }
  return { blocks, groups };
}

/** 电脑：按真实时长，重叠的并排分列；同一簇（连着重叠的）共用 columns */
function layoutDesk(segs: readonly Segment[]): DeskBlock[] {
  const out: DeskBlock[] = [];
  for (const members of clusters(segs, (s) => s.startMin, (s) => s.endMin)) {
    // 每列最后一块的结束分钟；放进第一列已空出来的，都占着就新开一列（只用 for 循环下标，F7）
    const colEnd: number[] = [];
    const cluster = members.map((s) => {
      let col = -1;
      for (let k = 0; k < colEnd.length; k++) {
        if ((colEnd[k] ?? Infinity) <= s.startMin) {
          colEnd[k] = s.endMin;
          col = k;
          break;
        }
      }
      if (col < 0) {
        col = colEnd.length;
        colEnd.push(s.endMin);
      }
      return { s, col };
    });
    for (const { s, col } of cluster) out.push({ ...base(s), column: col, columns: colEnd.length });
  }
  return out;
}

/**
 * 一周 7 天的周视图数据。weekStart 是这一周的第一天（resolveWeekParam / startOfWeek 规整过的）。
 * layout 'phone' 返回 PhoneDay[]，'desk' 返回 DeskDay[]。
 */
export function buildWeek(weekStart: DateStr, items: WeekItems, opts: PhoneWeekOpts): PhoneDay[];
export function buildWeek(weekStart: DateStr, items: WeekItems, opts: DeskWeekOpts): DeskDay[];
export function buildWeek(weekStart: DateStr, items: WeekItems, opts: PhoneWeekOpts | DeskWeekOpts): PhoneDay[] | DeskDay[] {
  if (opts.layout === 'phone' && !(opts.dayPx > 0 && opts.minBlockPx >= 0)) {
    throw new Error(`bad_week_opts:${opts.dayPx}/${opts.minBlockPx}`);
  }
  assertTz(opts.tz);
  const dates = weekDates(weekStart);
  const b = bucket(dates, items, opts.tz);
  const segsOf = (d: DateStr): Segment[] => (b.timed.get(d) ?? []).sort(compareSegments);
  const todosOf = (d: DateStr): DayEntry[] => b.todos.get(d) ?? [];
  if (opts.layout === 'phone') {
    return dates.map((date) => ({
      date,
      allDay: allDayOf(b.allDay.get(date) ?? []),
      todos: todosOf(date).sort(compareEntries),
      ...layoutPhone(segsOf(date), opts.minBlockPx, opts.dayPx),
    }));
  }
  // 电脑：待办并进全天那一行（compareEntries 把待办排在全天日程后面）
  return dates.map((date) => ({ date, allDay: allDayOf([...(b.allDay.get(date) ?? []), ...todosOf(date)]), blocks: layoutDesk(segsOf(date)) }));
}
