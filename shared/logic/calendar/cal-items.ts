// 月历和周视图共用：输入条目的形状、日程按设备时区落在哪天、一天里有哪几件事（架构 5.12 第 2 点、4.6）
// • 固定时刻（有 time 的日程）：按记录时的 events.tz 定出绝对时刻，再换算到设备当前时区，按换算后的日期和时刻放；
// • 浮动（全天日程、待办截止日）：日期原样，不换算。
// 纯函数：“设备当前时区”由调用方传进来（A15：和哪天有关的一律带 tz）。
import { addDays, msAt, parseDate, parseHm, todayOf, minOfDay, type DateStr } from '../../core/date.ts';
import { isValidTz, type Tz } from '../../core/tz.ts';
import type { EventWrite, TodoWrite } from '../../schema/rows.ts';
import { normalizeProject, projectColorIndex, type ProjectColor } from '../project-color.ts';
import { displayShort } from '../short.ts';

// 项目色挪到 shared/logic/project-color.ts（前端 A 会审 ①），这里转出保持原来的引用路径能用
export { PROJECT_COLORS, projectColorIndex, type ProjectColor } from '../project-color.ts';

/** 月历、周视图用到的日程列（本机缓存里的行直接传进来即可） */
export type CalEvent = Readonly<
  Pick<EventWrite, 'id' | 'title' | 'short' | 'project' | 'date' | 'time' | 'tz' | 'duration_min' | 'created_at' | 'deleted_at'>
>;
/** 月历用到的待办列 */
export type CalTodo = Readonly<Pick<TodoWrite, 'id' | 'title' | 'short' | 'project' | 'due' | 'done' | 'created_at' | 'deleted_at'>>;

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

/** 日程放在设备时区的哪一天、几点 */
export type EventPlacement =
  | { readonly allDay: true; readonly date: DateStr }
  | {
      readonly allDay: false;
      /** 换算到设备时区后的开始日期 */
      readonly date: DateStr;
      /** 开始、结束的绝对时刻（毫秒） */
      readonly startMs: number;
      readonly endMs: number;
      /** 设备时区里开始是当天第几分钟 */
      readonly startMin: number;
    };

function isDateStr(s: string): boolean {
  try {
    parseDate(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * 日程按 4.6 放进设备时区 tz 的哪一天。
 * • 日期或时刻格式坏了（正常不会有，schema 挡着）返回 null，调用方跳过这一条，不让整月算不出来；
 * • events.tz 不是有效的时区名（TZ-invalid-b2：数据库挡不住 `Foo/Bar`）或缺失时，当作设备时区的时刻，照样显示。
 */
export function placeEvent(ev: CalEvent, tz: Tz): EventPlacement | null {
  if (!isDateStr(ev.date)) return null;
  if (ev.time === null) return { allDay: true, date: ev.date };
  let min: number;
  try {
    min = parseHm(ev.time);
  } catch {
    return null;
  }
  const srcTz = ev.tz !== null && isValidTz(ev.tz) ? ev.tz : tz;
  const startMs = msAt(ev.date, min, srcTz);
  return {
    allDay: false,
    date: todayOf(startMs, tz),
    startMs,
    endMs: startMs + ev.duration_min * 60_000,
    startMin: minOfDay(startMs, tz),
  };
}

/** 月历一天里的一件事（排好序、取好简称和颜色） */
export interface DayEntry {
  readonly itemId: string;
  readonly kind: 'timed' | 'allDay' | 'todo';
  /** 规整后的项目名（normalizeProject；没有项目是空串），读屏按它汇总 */
  readonly project: string;
  readonly colorIndex: ProjectColor;
  readonly short: string;
  /** 有时刻的日程的开始时刻；全天日程、待办为 null */
  readonly startMs: number | null;
  readonly createdAt: number;
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

/** 日程 → 月历条目（kind 由 placement 定） */
export function eventEntry(ev: CalEvent, p: EventPlacement): DayEntry {
  return {
    itemId: ev.id,
    kind: p.allDay ? 'allDay' : 'timed',
    project: normalizeProject(ev.project),
    colorIndex: projectColorIndex(ev.project),
    short: displayShort(ev),
    startMs: p.allDay ? null : p.startMs,
    createdAt: ev.created_at,
  };
}

/** 待办 → 月历条目 */
export function todoEntry(td: CalTodo): DayEntry {
  return {
    itemId: td.id,
    kind: 'todo',
    project: normalizeProject(td.project),
    colorIndex: projectColorIndex(td.project),
    short: displayShort(td),
    startMs: null,
    createdAt: td.created_at,
  };
}

/**
 * 待办放在哪一天：截止日原样（浮动，不换算时区）；删掉的、已完成的、没有截止日的不上日历，返回 null。
 * 月历、单日列表、周视图共用这一条，规则只在这里改。
 */
export function todoDate(td: CalTodo): string | null {
  if (td.deleted_at !== null || td.done || td.due === null) return null;
  return td.due;
}

/** ev.date 在不在 [from − spill, to + spill] 里（'YYYY-MM-DD' 按字符串比就是按日期比） */
export function nearRange(date: string, from: DateStr, to: DateStr, spillBefore: number, spillAfter: number): boolean {
  return date >= addDays(from, -spillBefore) && date <= addDays(to, spillAfter);
}

/**
 * from～to（含两头）每一天有哪几件事，已按 compareEntries 排好。
 * 算进去的：没删掉的日程（固定时刻按设备时区换算后的日期）、截止日在范围里且未完成的待办。
 * 月历的 buildMonth 和单日列表的 dayEntries 共用这一套。
 */
export function collectEntries(items: CalItems, from: DateStr, to: DateStr, tz: Tz): Map<DateStr, DayEntry[]> {
  const out = new Map<DateStr, DayEntry[]>();
  for (let d = from; d <= to; d = addDays(d, 1)) out.set(d, []);
  for (const ev of items.events) {
    if (ev.deleted_at !== null || !nearRange(ev.date, from, to, TZ_SPILL_DAYS, TZ_SPILL_DAYS)) continue;
    const p = placeEvent(ev, tz);
    if (p) out.get(p.date)?.push(eventEntry(ev, p));
  }
  for (const td of items.todos) {
    const d = todoDate(td);
    if (d !== null) out.get(d)?.push(todoEntry(td));
  }
  for (const list of out.values()) list.sort(compareEntries);
  return out;
}

/** 某一天有哪几件事（删掉的、已完成的待办不算；按 compareEntries 排）。点开某天的列表、读屏全文用 */
export function dayEntries(date: DateStr, items: CalItems, tz: Tz): DayEntry[] {
  parseDate(date);
  assertTz(tz);
  return collectEntries(items, date, date, tz).get(date) ?? [];
}
