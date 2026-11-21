// 月历和周视图共用：输入条目的形状、日程按设备时区落在哪天、一天里有哪几件事（架构 5.12 第 2 点、4.6）
// • 固定时刻（有 time 的日程）：按记录时的 events.tz 定出绝对时刻，再换算到设备当前时区，按换算后的日期和时刻放；
// • 浮动（全天日程、待办截止日）：日期原样，不换算。
// 纯函数：“设备当前时区”由调用方传进来（A15：和哪天有关的一律带 tz）。
import { addDays, parseDate, type DateStr } from '../../core/date.ts';
import { isValidTz, type Tz } from '../../core/tz.ts';
import type { EventWrite, TodoWrite } from '../../schema/rows.ts';
import { contOn, EVENT_SPAN_MAX_DAYS, placeEvent, spanDaysIn, type Cont, type EventPlacement } from './event-span.ts';
import { normalizeProject, projectColorIndex, type ProjectColor } from '../project-color.ts';
import { isLiveRow, type Tombstone } from '../live-row.ts';
import { displayShort } from '../short.ts';

// 项目色挪到 shared/logic/project-color.ts（前端 A 会审 ①），这里转出保持原来的引用路径能用
export { PROJECT_COLORS, projectColorIndex, type ProjectColor } from '../project-color.ts';

/** 月历、周视图用到的日程列，加上删除、撤销两列（live-row.ts 的 Tombstone，可以没有；本机缓存里的行直接传进来即可） */
export type CalEvent = Readonly<Pick<EventWrite, 'id' | 'title' | 'short' | 'short_by' | 'project' | 'date' | 'time' | 'tz' | 'duration_min' | 'created_at'>> &
  Tombstone;
/** 月历用到的待办列（short_by：displayShort 分用户手改和 AI 起的，R-446） */
export type CalTodo = Readonly<Pick<TodoWrite, 'id' | 'title' | 'short' | 'short_by' | 'project' | 'due' | 'done' | 'created_at'>> & Tombstone;

/** 月历、单日列表的输入 */
export interface CalItems {
  readonly events: readonly CalEvent[];
  readonly todos: readonly CalTodo[];
}

/**
 * 固定时刻换算到别的时区，日期最多差 2 天（UTC−12 的 23:59 = UTC+14 的后天 01:59）。
 * 按 ev.date 预筛时，要算的日期范围两头各放宽这么多天，范围外的不做时区换算（代码审查 A：上千条时省掉大部分 Intl 调用）。
 */
export const TZ_SPILL_DAYS = 2;

/** 设备时区无效时抛 bad_tz（代码审查 C）：在入口挡住，别等到第一条有时刻的日程才抛 RangeError */
export function assertTz(tz: Tz): void {
  if (!isValidTz(tz)) throw new Error(`bad_tz:${tz}`);
}

/** 月历一天里的一件事（排好序、取好简称和颜色） */
export interface DayEntry {
  readonly itemId: string;
  readonly kind: 'timed' | 'allDay' | 'todo';
  /** 规整后的项目名（normalizeProject；没有项目是空串），读屏按它汇总 */
  readonly project: string;
  readonly colorIndex: ProjectColor;
  readonly short: string;
  /** 完整标题（手机周视图色块、全天条写它，负责人 11-17“周历上显示全部文字”；月格照旧写 short） */
  readonly title: string;
  /** 有时刻的日程的开始时刻；全天日程、待办为 null */
  readonly startMs: number | null;
  /** 有时刻的日程的结束时刻；全天日程、待办为 null */
  readonly endMs: number | null;
  readonly createdAt: number;
  /** 跨天的日程（R-444）：这一条是哪一天的那一段（cont 同 Cont）、开始和最后一天；只占一天的没有 */
  readonly span?: { readonly cont: Cont; readonly date: DateStr; readonly lastDate: DateStr };
  /** 日程放在哪几天、几点（placeEvent 的结果；日清单 spanTextOn、周视图切段直接用）；待办没有 */
  readonly place?: EventPlacement;
  /** 已完成的待办（只有周历留着、划删除线，负责人 11-21“勾选完成的待办在周历不消失，只划删除线，要留痕”）；没完成的、日程没有这一项 */
  readonly done?: true;
}

/** collectEntries 的选项：keepDone = 已完成的待办也放进来（只有周历这样，月历、单日列表、“本周 N 项”照旧不放） */
export interface CollectOpts {
  readonly keepDone?: boolean;
}

/** 排序时的先后：有时刻的日程 0、全天日程 1、待办 2（check_backend F7：方括号里的键要追得到字面量，查表改用 switch） */
function kindRank(kind: DayEntry['kind']): number {
  switch (kind) {
    case 'timed':
      return 0;
    case 'allDay':
      return 1;
    case 'todo':
      return 2;
  }
}

/** 5.12 的排序：有时刻的日程按时刻先后，然后全天日程，然后待办；同序按创建时间（再按 id，保证结果稳定） */
export function compareEntries(a: DayEntry, b: DayEntry): number {
  return (
    kindRank(a.kind) - kindRank(b.kind) ||
    (a.startMs ?? 0) - (b.startMs ?? 0) ||
    a.createdAt - b.createdAt ||
    (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)
  );
}

/**
 * 日程 → 月历条目（kind 由 placement 定）；跨天的日程 days 里每一天各一条，只差 span（哪一段）。
 * 简称（displayShort 要切字形簇）、项目色每件事只算一次，不按天重算（11-17 日历整块评审第 4 条）
 */
function eventEntries(ev: CalEvent, p: EventPlacement, days: readonly DateStr[]): [DateStr, DayEntry][] {
  if (days.length === 0) return [];
  const base: DayEntry = {
    itemId: ev.id,
    kind: p.allDay ? 'allDay' : 'timed',
    project: normalizeProject(ev.project),
    colorIndex: projectColorIndex(ev.project),
    short: displayShort(ev),
    title: ev.title,
    startMs: p.allDay ? null : p.startMs,
    endMs: p.allDay ? null : p.endMs,
    createdAt: ev.created_at,
    place: p,
  };
  return days.map((day) => {
    const cont = contOn(p, day);
    return [day, cont === undefined ? base : { ...base, span: { cont, date: p.date, lastDate: p.lastDate } }];
  });
}

/** 待办 → 月历条目 */
export function todoEntry(td: CalTodo): DayEntry {
  return {
    itemId: td.id,
    kind: 'todo',
    project: normalizeProject(td.project),
    colorIndex: projectColorIndex(td.project),
    short: displayShort(td),
    title: td.title,
    startMs: null,
    endMs: null,
    createdAt: td.created_at,
    ...(td.done ? { done: true as const } : {}),
  };
}

/**
 * 待办放在哪一天：截止日原样（浮动，不换算时区）；删掉的、撤销的、已完成的、没有截止日的不上日历，返回 null。
 * keepDone：已完成的也放（只有周历，负责人 11-21“周历不消失，只划删除线”）。月历、单日列表、周视图共用这一条，规则只在这里改。
 */
export function todoDate(td: CalTodo, keepDone = false): string | null {
  if (!(keepDone ? isLiveRow(td) : isOpenTodo(td)) || td.due === null) return null;
  return td.due;
}

/** 待办还开着：没删、没撤销、没完成。月历、周视图（经 todoDate）和“＋”找候选共用 */
export function isOpenTodo(td: Tombstone & Readonly<Pick<TodoWrite, 'done'>>): boolean {
  return isLiveRow(td) && !td.done;
}

/** ev.date 在不在 [from − spill, to + spill] 里（'YYYY-MM-DD' 按字符串比就是按日期比） */
function nearRange(date: string, from: DateStr, to: DateStr, spillBefore: number, spillAfter: number): boolean {
  return date >= addDays(from, -spillBefore) && date <= addDays(to, spillAfter);
}

/**
 * 没删、没撤销、可能落在 from～to 的日程，连同换算到设备时区后的位置。月历、周视图、“＋”找候选、单日列表的跨午夜续段共用这一条。
 * 只按 ev.date 预筛（前面放宽 TZ_SPILL_DAYS + extraBefore 天，后面 TZ_SPILL_DAYS 天），不按换算后的日子复核：
 * 月历按日子放进格子、周视图要按午夜切段、找候选按 from～to 复核，各自处理。
 */
export function liveEventsNear<E extends CalEvent>(events: readonly E[], from: DateStr, to: DateStr, tz: Tz, extraBefore = 0): [E, EventPlacement][] {
  const out: [E, EventPlacement][] = [];
  for (const ev of events) {
    if (!isLiveRow(ev) || !nearRange(ev.date, from, to, TZ_SPILL_DAYS + extraBefore, TZ_SPILL_DAYS)) continue;
    const p = placeEvent(ev, tz);
    if (p) out.push([ev, p]);
  }
  return out;
}

/**
 * from～to（含两头）每一天有哪几件事，已按 compareEntries 排好。
 * 算进去的：没删掉、没撤销的日程（固定时刻按设备时区换算后的日期）、截止日在范围里且未完成的待办（isLiveRow）。
 * 跨天的日程（R-444；含跨午夜的）它占的每一天都放一条，带 span 标出是哪一段；预筛往前多看 31 天（最长跨度），前一个月开始、跨进来的也算。
 * 月历的 buildMonth 和单日列表的 dayEntries 共用这一套。
 */
export function collectEntries(items: CalItems, from: DateStr, to: DateStr, tz: Tz, opts: CollectOpts = {}): Map<DateStr, DayEntry[]> {
  const out = new Map<DateStr, DayEntry[]>();
  for (let d = from; d <= to; d = addDays(d, 1)) out.set(d, []);
  for (const [ev, p] of liveEventsNear(items.events, from, to, tz, EVENT_SPAN_MAX_DAYS)) {
    for (const [d, e] of eventEntries(ev, p, spanDaysIn(p, from, to))) out.get(d)?.push(e);
  }
  for (const td of items.todos) {
    const d = todoDate(td, opts.keepDone);
    if (d !== null) out.get(d)?.push(todoEntry(td));
  }
  for (const list of out.values()) list.sort(compareEntries);
  return out;
}

/** from～to（含两头）一共几件事（日历顶部“本月 N 项”“本周 N 项”，负责人 11-18 选甲方案）：跨天的日程只算一件；口径同 collectEntries */
export function countEntries(items: CalItems, from: DateStr, to: DateStr, tz: Tz): number {
  assertTz(tz);
  const ids = new Set<string>();
  for (const list of collectEntries(items, from, to, tz).values()) for (const e of list) ids.add(`${e.kind}:${e.itemId}`);
  return ids.size;
}

/** 某一天有哪几件事（删掉的、已完成的待办不算；按 compareEntries 排）。点开某天的列表、读屏全文用 */
export function dayEntries(date: DateStr, items: CalItems, tz: Tz): DayEntry[] {
  parseDate(date);
  assertTz(tz);
  return collectEntries(items, date, date, tz).get(date) ?? [];
}
