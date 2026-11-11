// “＋”取消、改期、完成在本机缓存里找候选（架构 5.14 第 7 点）：不调 AI、不联网；target 要先过 resolveTarget。
// 单条：先过命中关（关键词命中标题或地点；泛指词或空时要同一天同一时刻）再排序，最多 SINGLE_MAX 条。
// 批量（all）：不打分，按日子、with_overdue、kinds 和具体词筛，按日期、时刻排，最多 BATCH_MAX 条，多出的计进 more。
// 日程按记录时区换算到设备时区 tz 后的日期和时刻（4.6）；全天日程、待办截止日不换算。
import { addDays, diffDays, fmtHm, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import type { EventWrite, TodoWrite } from '../../schema/rows.ts';
import { assertTz, isOpenTodo, liveEventsNear, type CalEvent, type CalTodo } from '../calendar/cal-items.ts';
import { matchScore, type Field } from '../search.ts';
import { specificWords } from './generic-words.ts';
import { isScoped, type PlusTarget, type TargetKind } from './resolve-target.ts';

export type TargetEvent = CalEvent & Readonly<Pick<EventWrite, 'location'>>;
export type TargetTodo = CalTodo & Readonly<Pick<TodoWrite, 'due_time'>>;
export interface TargetItems {
  readonly events: readonly TargetEvent[];
  readonly todos: readonly TargetTodo[];
}
/** 一条候选：日程的 date、time 是换算到设备时区后的；待办是截止日和截止时刻 */
export interface TargetHit {
  kind: TargetKind;
  id: string;
  date: DateStr | null;
  time: string | null;
}
export interface TargetMatch {
  hits: TargetHit[];
  /** 批量时超过 BATCH_MAX 的条数（卡片写“还有 N 条，请在列表里改”）；单条恒为 0 */
  more: number;
}

/** 单条模式没说日子时，日程看今天起多少天 */
export const EVENT_WINDOW_DAYS = 14;
export const SINGLE_MAX = 3;
export const BATCH_MAX = 50;

interface Row extends TargetHit {
  fields: readonly Field[];
}

/** 没删、没撤销的日程里，换算后落在 from～to 的 */
function placedEvents(events: readonly TargetEvent[], from: DateStr, to: DateStr, tz: Tz): Row[] {
  return liveEventsNear(events, from, to, tz)
    .filter(([, p]) => p.date >= from && p.date <= to)
    .map(([ev, p]) => ({ kind: 'event' as const, id: ev.id, date: p.date, time: p.allDay ? null : fmtHm(p.startMin), fields: [ev.title, ev.location] }));
}

/** 没删、没撤销、没完成，且截止日过了 keep 的待办 */
function openTodos(todos: readonly TargetTodo[], keep: (due: DateStr | null) => boolean): Row[] {
  return todos
    .filter((td) => isOpenTodo(td) && keep(td.due))
    .map((td) => ({ kind: 'todo' as const, id: td.id, date: td.due, time: td.due_time, fields: [td.title] }));
}

/** 日期先后、同一天按时刻，没日期、没时刻的排后；最后按 id，结果稳定 */
const nullLast = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
const byDateTime = (a: TargetHit, b: TargetHit): number => nullLast(a.date, b.date) || nullLast(a.time, b.time) || nullLast(a.id, b.id);
const hitOf = ({ kind, id, date, time }: Row): TargetHit => ({ kind, id, date, time });

function single(t: PlusTarget, items: TargetItems, today: DateStr, tz: Tz): TargetMatch {
  const words = specificWords(t.text);
  if (words === '' && (t.date === null || t.time === null)) return { hits: [], more: 0 };
  const rows: Row[] = [];
  if (t.kinds.includes('event')) rows.push(...placedEvents(items.events, t.date ?? today, t.date ?? addDays(today, EVENT_WINDOW_DAYS), tz));
  if (t.kinds.includes('todo')) {
    const cut = t.date ?? today;
    rows.push(...openTodos(items.todos, (due) => (t.with_overdue === true ? due !== null && due <= cut : t.date === null || due === t.date)));
  }
  const scored = rows
    .map((r) => ({ r, score: words === '' ? (r.date === t.date && r.time === t.time ? 1 : 0) : matchScore(r.fields, words) }))
    .filter((x) => x.score > 0);
  const sameTime = (r: Row) => (t.time !== null && r.time === t.time ? 0 : 1);
  const far = (r: Row) => (r.date === null ? Number.MAX_SAFE_INTEGER : Math.abs(diffDays(today, r.date)));
  scored.sort((a, b) => sameTime(a.r) - sameTime(b.r) || b.score - a.score || far(a.r) - far(b.r) || byDateTime(a.r, b.r));
  return { hits: scored.slice(0, SINGLE_MAX).map((x) => hitOf(x.r)), more: 0 };
}

function batch(t: PlusTarget, items: TargetItems, today: DateStr, tz: Tz): TargetMatch {
  const day = t.date ?? today;
  const words = specificWords(t.text);
  const rows: Row[] = [];
  if (t.kinds.includes('event')) rows.push(...placedEvents(items.events, day, day, tz));
  if (t.kinds.includes('todo')) rows.push(...openTodos(items.todos, (due) => due !== null && (t.with_overdue === true ? due <= day : due === day)));
  const hits = rows.filter((r) => words === '' || matchScore(r.fields, words) > 0).sort(byDateTime);
  return { hits: hits.slice(0, BATCH_MAX).map(hitOf), more: Math.max(0, hits.length - BATCH_MAX) };
}

/** 找候选；now、tz 是“现在”和设备当前时区 */
export function matchTarget(target: PlusTarget, items: TargetItems, now: number, tz: Tz): TargetMatch {
  assertTz(tz);
  const today = todayOf(now, tz);
  return target.all === true && isScoped(target) ? batch(target, items, today, tz) : single(target, items, today, tz);
}
