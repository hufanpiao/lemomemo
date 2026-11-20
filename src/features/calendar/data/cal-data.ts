// 本机缓存的行 → 前端 B 月历、周视图纯逻辑的输入（B2 FA-3）
// • 本机行的列都是 unknown（可能是旧版本写的、也可能缺列），这里逐列取：类型不对的给安全的默认值，
//   连 id 或日期都没有的行直接跳过，免得一条坏行让整个月历画不出来
// • 删除、撤销不在这里筛：交给纯逻辑的 isLiveRow（deleted_at、undone 原样带过去）
// 纯 TS
import { parseHm, type DateStr } from '../../../../shared/core/date.ts';
import { str } from '../../../../shared/core/field.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import type { CalEvent, CalItems, CalTodo } from '../../../../shared/logic/calendar/cal-items.ts';
import { spanRowOf } from '../../../../shared/logic/calendar/event-span.ts';
import { isLate, todoOf as todoFields, type TodoFields } from '../../../../shared/logic/todo-row.ts';

export type Row = Readonly<{ id: string } & Record<string, unknown>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isDate = (v: unknown): v is DateStr => typeof v === 'string' && DATE.test(v);
/** 简称是谁写的（R-446 displayShort 用）：不认识的值当 null */
const shortByOf = (v: unknown): 'ai' | 'user' | null => (v === 'ai' || v === 'user' ? v : null);

/** 日期、时刻、时区、时长照原样交给 event-span.ts 的 placeEvent（spanRowOf 只管类型）：坏日期、坏时刻不显示，坏时区按设备时区，坏时长按 1 小时，和今天页、提醒同一套 */
function eventOf(r: Row): CalEvent | null {
  const span = spanRowOf(r);
  if (typeof r.id !== 'string' || span === null) return null;
  return {
    id: r.id,
    title: str(r['title']),
    short: strOrNull(r['short']),
    short_by: shortByOf(r['short_by']),
    project: str(r['project']),
    ...span,
    created_at: num(r['created_at'], 0),
    deleted_at: numOrNull(r['deleted_at']),
    undone: r['undone'] === true,
  };
}

function todoOf(r: Row): CalTodo | null {
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    title: str(r['title']),
    short: strOrNull(r['short']),
    short_by: shortByOf(r['short_by']),
    project: str(r['project']),
    due: isDate(r['due']) ? r['due'] : null,
    done: r['done'] === true,
    created_at: num(r['created_at'], 0),
    deleted_at: numOrNull(r['deleted_at']),
    undone: r['undone'] === true,
  };
}

/** 两个集合 → CalItems（坏行跳过） */
export function calItemsOf(events: readonly Row[], todos: readonly Row[]): CalItems {
  const ev: CalEvent[] = [];
  for (const r of events) {
    const e = eventOf(r);
    if (e) ev.push(e);
  }
  const td: CalTodo[] = [];
  for (const r of todos) {
    const t = todoOf(r);
    if (t) td.push(t);
  }
  return { events: ev, todos: td };
}

/**
 * 待办 id → 读好的待办（shared/logic/todo-row.ts 的 todoOf，待办页、今天页同一份：截止日不是 YYYY-MM-DD、截止时刻不是 HH:MM 的当没有，
 * 没截止日时截止时刻也当没有）。CalTodo（前端 B 的纯逻辑类型）没有截止时刻，周视图的空心圆画在哪（架构 5.12 0.51、设计审查 M2）、
 * 这一天有没有逾期都从这一张表读，不再自己写正则、自己比“当天第几分钟”（改善报告 11-20 二-3）
 */
export function calTodoFields(todos: readonly Row[]): ReadonlyMap<string, TodoFields> {
  return new Map(todos.map((r) => [r.id, todoFields(r)]));
}

/** 截止时刻是当天第几分钟；没有截止时刻的 undefined（周视图画在泳道末端） */
export const dueMinOf = (t: TodoFields | undefined): number | undefined => (t?.dueTime ? parseHm(t.dueTime) : undefined);

/** 这几条待办里有没有逾期没做完的：逐条用待办页同一个 isLate（截止日已过，或今天截止、到了截止那一分钟起） */
export function anyLate(ids: readonly string[], todos: ReadonlyMap<string, TodoFields>, now: number, tz: Tz): boolean {
  return ids.some((id) => {
    const t = todos.get(id);
    return t !== undefined && isLate(t, now, tz);
  });
}

