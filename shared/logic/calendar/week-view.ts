// 周视图的数据和布局（架构 5.12 第 2 点、R-107、R-109、R-110；第 9 节“buildWeek 布局”；TC-B2-09）
// buildWeek(weekStart, items, opts)：weekStart 是这一周的第一天，返回 7 天，每天：
// • 全天日程不上时间轴，记成“全天 N”（N = 1 时带简称）；跨天的全天日程（R-444）它占的每一天都算一件，allDay.entries 里带 span（第几天、被切的一边）；
// • 有时刻的日程按设备时区换算，跨午夜、跨多天的（R-444，最长 31 天）按午夜切段，各归各天，cont 标出被切的一边（'end' = 尾部被切，
//   'start' = 头部被切，'both' = 两头都被切，中间整天那几段），界面在被切的一端画成直边；
// • 手机（layout 'phone'，时间轴横向）：色块长度取 max(按时长算的长度, minBlockPx, 写下完整标题的宽 textPx)，超出轨道末端的截到末端，
//   截完不够最小长度的右端对齐末端、往左补足（负责人 11-17“周历上显示全部文字，时间以开始时间为准”）；
//   按开始排好依次放进第一排空着的（row 0、1、2…，不设上限、不收成“+N”，负责人 11-18“周历目的就是将全部日程都能一眼看清楚”“+2的日程跟代办也都显示出来”）；
// • 电脑（layout 'desk'，时间轴纵向，相当于 minBlockPx = 0）：按真实时长画，重叠的并排分列，块带 column、columns。
// • 待办（和前端 A 对过的接口）：规则和月历一样（todoDate：删掉的、撤销的、已完成的、没有截止日的不放，截止日是浮动日期不换算），
//   手机放进当天的 todos（“○ 标题”小条：有截止时刻的和时刻块一起排，没有的在时刻那几排下面从左往右排），电脑并进 allDay 那一行（排在全天日程后面）。纯函数。
import { DAY_MINUTES, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import type { ProjectColor } from '../project-color.ts';
import {
  assertTz,
  collectEntries,
  compareEntries,
  type CalEvent,
  type CalTodo,
  type DayEntry,
} from './cal-items.ts';
import { weekDates } from './cal-nav.ts';
import { dayOfSpan, endMinOn, type Cont } from './event-span.ts';

/** 一天里的一段（跨午夜的日程切开以后各段分别算；被切的哪一边看 entry.span.cont） */
interface Segment {
  readonly entry: DayEntry;
  /** 哪一天的那一段 */
  readonly day: DateStr;
  readonly startMin: number;
  readonly endMin: number;
}

interface BlockBase {
  readonly itemId: string;
  readonly colorIndex: ProjectColor;
  readonly short: string;
  /** 完整标题（手机周视图色块写它，负责人 11-17“周历上显示全部文字”） */
  readonly title: string;
  /** 当天第几分钟开始、结束（结束可以是 1440 = 到当天末尾） */
  readonly startMin: number;
  readonly endMin: number;
  readonly cont?: Cont;
  /** 跨天的日程这一段是第几天、共几天（R-445 周视图续条右端写“2/3”）；只占一天的没有 */
  readonly dayOf?: DayOf;
}

/** 跨天日程某一段是第几天、共几天（event-span.ts dayOfSpan 的结果） */
export type DayOf = { readonly index: number; readonly days: number };

/** 手机上的时刻块：row 是时刻那几排里的第几排（0 起，不设上限，负责人 11-18“周历目的就是将全部日程都能一眼看清楚”） */
export interface PhoneBlock extends BlockBase {
  readonly startPx: number;
  readonly widthPx: number;
  readonly row: number;
}

/** 手机上的待办小条（“○ 标题”）：有截止时刻的和时刻块一起排在 row 那一排的截止时刻处；没有的在时刻那几排下面从左往右排 */
export interface PhoneTodo {
  readonly entry: DayEntry;
  readonly startPx: number;
  readonly widthPx: number;
  readonly row: number;
}

export interface DeskBlock extends BlockBase {
  readonly column: number;
  readonly columns: number;
}

/** 全天事项：count 件；只有 1 件时 short 是它的简称，否则 null（电脑上待办也算在这一行里） */
export interface AllDay {
  readonly count: number;
  readonly short: string | null;
  /**
   * 这一天的全天事项（按 compareEntries 排好）：kind 'allDay' 是全天日程，'todo' 是待办（只有电脑那一行有，画“○ 标题”）；
   * 项目色、简称直接用，不回原始数据里找；跨天的看 span（第几天、共几天用 dayOfSpan，被切的一边是 span.cont，R-444、R-445）
   */
  readonly entries: readonly DayEntry[];
}

export interface PhoneDay {
  readonly date: DateStr;
  readonly allDay: AllDay;
  /** 截止日是这一天的待办小条（按 compareEntries 排） */
  readonly todos: readonly PhoneTodo[];
  readonly blocks: readonly PhoneBlock[];
  /** 时刻块和待办一共占几排（全天日程另算，每件一排，见 allDay.entries） */
  readonly rows: number;
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
  /**
   * 轨道右端在这一天坐标里的位置（px，0:00 在 0）：时间轴只显示到 22 点这类时，色块撑开后写到这里为止。不传就是 dayPx（24:00）
   */
  readonly endPx?: number;
  /** 轨道左端在这一天坐标里的位置（px）：时间轴从 8 点起时没有截止时刻的待办从这里往右排。不传是 0 */
  readonly startPx?: number;
  /**
   * 写下完整标题要多宽（px，含色块左右内边距）：界面按色块实际字体量（WeekView 用 canvas measureText，结果缓存）。
   * 跨天的这一段还带 of（第几天、共几天）：色块右端要写“2/3”，界面把这几个字（等宽小字、前面的空隙）也算进去（11-17 日历整块评审第 1 条）。
   * 传了时色块宽 = max(按时长的宽, minBlockPx, textPx(标题, of))，从开始时刻起画、写到轨道末端为止（负责人 11-17“周历上显示全部文字，
   * 时间以开始时间为准，结束时间对不上也没关系”）；撑开后撞上的往下一排放。不传（服务器一侧、单测）按原来的规则
   */
  readonly textPx?: (title: string, of?: DayOf) => number;
  /** 待办截止时刻（当天第几分钟；没有截止时刻的给 undefined）：小条从这里起画。不传就全按没有截止时刻排 */
  readonly dueMin?: (todoId: string) => number | undefined;
  /** 待办小条要多宽（px，含圆圈和内边距）；不传按 minBlockPx */
  readonly todoPx?: (title: string) => number;
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

/** 没有截止时刻的待办小条之间的空隙（px） */
const TODO_GAP_PX = 6;

interface DayBuckets {
  readonly allDay: Map<DateStr, DayEntry[]>;
  readonly timed: Map<DateStr, Segment[]>;
  readonly todos: Map<DateStr, DayEntry[]>;
}

/** 这一周每天的事项按种类分开：月历、日清单同一份 collectEntries（每天一条、已排好），有时刻的按那一天切成段 */
function bucket(dates: readonly DateStr[], items: WeekItems, tz: Tz): DayBuckets {
  const allDay = new Map<DateStr, DayEntry[]>(dates.map((d) => [d, []]));
  const timed = new Map<DateStr, Segment[]>(dates.map((d) => [d, []]));
  const todos = new Map<DateStr, DayEntry[]>(dates.map((d) => [d, []]));
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) return { allDay, timed, todos };
  for (const [d, entries] of collectEntries(items, first, last, tz)) {
    for (const e of entries) {
      const seg = segmentOn(e, d, tz);
      if (e.kind === 'todo') todos.get(d)?.push(e);
      else if (seg === null) allDay.get(d)?.push(e);
      else timed.get(d)?.push({ entry: e, day: d, ...seg });
    }
  }
  return { allDay, timed, todos };
}

/**
 * 有时刻的日程在 d 这一天占第几分钟到第几分钟（开始那天从开始时刻起、其余从 0:00 起；结束不在这一天的到 24:00）；全天日程、待办 null。
 * buildWeek 切段和周视图算时间轴范围（WeekView rangeOf，11-17 日历整块评审第 4 条：手机上不再为了范围整周排一遍电脑布局）共用
 */
export function segmentOn(e: DayEntry, d: DateStr, tz: Tz): { startMin: number; endMin: number } | null {
  if (e.kind === 'todo' || e.place === undefined || e.place.allDay) return null;
  const startMin = d === e.place.date ? e.place.startMin : 0;
  return { startMin, endMin: Math.max(startMin, endMinOn(e.place.endMs, d, tz)) };
}

function allDayOf(entries: DayEntry[]): AllDay {
  const sorted = entries.sort(compareEntries);
  const only = sorted.length === 1 ? sorted[0] : undefined;
  return { count: sorted.length, short: only ? only.short : null, entries: sorted };
}

/** 段的排序：开始分钟，再按创建时间、id（结果稳定） */
function compareSegments(a: Segment, b: Segment): number {
  return a.startMin - b.startMin || compareEntries(a.entry, b.entry);
}

/** 这一段是跨天日程的第几天（只占一天的 undefined） */
function ofSeg(s: Segment): DayOf | undefined {
  return s.entry.span === undefined ? undefined : dayOfSpan(s.entry.span, s.day);
}

function base(s: Segment): BlockBase {
  const span = s.entry.span;
  const of = ofSeg(s);
  return {
    itemId: s.entry.itemId,
    colorIndex: s.entry.colorIndex,
    short: s.entry.short,
    title: s.entry.title,
    startMin: s.startMin,
    endMin: s.endMin,
    ...(span === undefined ? {} : { cont: span.cont }),
    ...(of === undefined ? {} : { dayOf: of }),
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

/** 放进第一排右端不超过 start 的那一排（都占着就新开一排）；ends 是各排最后一件的右端，就地更新 */
function firstFree(ends: number[], start: number, right: number): number {
  for (let k = 0; k < ends.length; k++) {
    if ((ends[k] ?? Infinity) <= start) {
      ends[k] = right;
      return k;
    }
  }
  ends.push(right);
  return ends.length - 1;
}

/**
 * 手机：时刻块从开始时刻起画，想要的宽 = max(按时长的宽, minPx, 写下完整标题的宽)，写到轨道末端（end）为止；
 * 剩下不到 minPx 时右端对齐末端、往左补足（原来的兜底）。
 * 排法（负责人 11-18“周历目的就是将全部日程都能一眼看清楚”，原来最多两排、多的收成“+N”，整块换成这一种）：
 * 时刻块和有截止时刻的待办按起点排好，依次放进第一排空着的，不设上限；没有截止时刻的待办在这些排下面从左往右排，放不下换下一排
 */
function layoutPhone(
  segs: readonly Segment[],
  todos: readonly DayEntry[],
  o: { minPx: number; dayPx: number; start: number; end: number; textPx?: ((title: string, of?: DayOf) => number) | undefined; dueMin?: ((id: string) => number | undefined) | undefined; todoPx?: ((title: string) => number) | undefined },
): { blocks: PhoneBlock[]; todos: PhoneTodo[]; rows: number } {
  const { minPx, dayPx, start, end } = o;
  const scale = dayPx / DAY_MINUTES;
  // 从 at 起画、想要 want 宽：写到末端为止，不够最小长度的右端对齐末端往左补足
  const fit = (at: number, want: number): { startPx: number; widthPx: number } => {
    const w = Math.min(want, end - at);
    return w < minPx ? { startPx: Math.max(0, end - minPx), widthPx: Math.min(minPx, end) } : { startPx: at, widthPx: w };
  };
  const todoW = (e: DayEntry): number => Math.max(minPx, o.todoPx ? o.todoPx(e.title) : 0);
  type Item = { startPx: number; widthPx: number; seg?: Segment; todo?: DayEntry };
  const timed: Item[] = segs.map((s) => ({
    seg: s,
    ...fit(s.startMin * scale, Math.max((s.endMin - s.startMin) * scale, minPx, o.textPx ? o.textPx(s.entry.title, ofSeg(s)) : 0)),
  }));
  const loose: DayEntry[] = [];
  for (const e of todos) {
    const due = o.dueMin?.(e.itemId);
    if (due === undefined) loose.push(e);
    else timed.push({ todo: e, ...fit(due * scale, todoW(e)) });
  }
  // 起点先后；同一起点时刻块在前（segs、todos 各自已排好，sort 是稳定的）
  timed.sort((a, b) => a.startPx - b.startPx);
  const ends: number[] = [];
  const blocks: PhoneBlock[] = [];
  const out: PhoneTodo[] = [];
  for (const it of timed) {
    const row = firstFree(ends, it.startPx, it.startPx + it.widthPx);
    if (it.seg) blocks.push({ ...base(it.seg), startPx: it.startPx, widthPx: it.widthPx, row });
    else if (it.todo) out.push({ entry: it.todo, startPx: it.startPx, widthPx: it.widthPx, row });
  }
  // 没有截止时刻的：接在时刻那几排下面，一排从左往右排满再换下一排（小条之间留 TODO_GAP_PX）
  let row = ends.length - 1;
  let x = Infinity;
  for (const e of loose) {
    const w = Math.min(todoW(e), end - start);
    if (x + w > end) {
      row++;
      x = start;
    }
    out.push({ entry: e, startPx: x, widthPx: w, row });
    x += w + TODO_GAP_PX;
  }
  out.sort((a, b) => compareEntries(a.entry, b.entry));
  return { blocks, todos: out, rows: row + 1 };
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
      ...layoutPhone(segsOf(date), todosOf(date).sort(compareEntries), {
        minPx: opts.minBlockPx,
        dayPx: opts.dayPx,
        start: Math.max(0, opts.startPx ?? 0),
        end: Math.min(opts.endPx ?? opts.dayPx, opts.dayPx),
        textPx: opts.textPx,
        dueMin: opts.dueMin,
        todoPx: opts.todoPx,
      }),
    }));
  }
  // 电脑：待办并进全天那一行（compareEntries 把待办排在全天日程后面）
  return dates.map((date) => ({ date, allDay: allDayOf([...(b.allDay.get(date) ?? []), ...todosOf(date)]), blocks: layoutDesk(segsOf(date)) }));
}
