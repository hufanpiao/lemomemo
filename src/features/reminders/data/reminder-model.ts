// 提醒的数据模型（B2 任务单 FA-4；架构 5.3、5.9“错过的提醒”“未来 7 天的提醒清单”、0.29 P-04、4.6）：纯 TS，不碰 React 和 DOM
// • remind_at 本机现算（TC-B2-29）：用 shared/logic/remind.ts 的 remindAtOf，和服务器（push-dispatch 第 0 步）同一份；
//   待办按“其余重算”传这一行现在的 remind_at（从没同步过、本机没有这一列的不传，走新建时的回落）
// • 这一次到点 due_at = greatest(remind_at, snooze_at, defer_until)（5.3 第 1 步，null 不算）；落在免打扰里的推迟到免打扰结束
//   （本机提醒同样经 applyDnd，remind.ts 文件头）
// • 已处理：notified_for 等于 remind_at（按过“知道了”）；已删、已撤销、待办已完成的不算提醒
// • 正在响（ringing）：本次打开 App 以后到点的、没处理、没收起的；打开前就到点了的进“错过的提醒”（下次打开时在今天页顶部）
// • 错过的提醒（missed，5.9）：最近 7 天里 due_at 已过、没按“知道了”、也不在正在响的队列里（收起的算错过）
// • 未来 7 天（upcoming，TC-B2-66）：今天起 7 天（含今天，到第 7 天 24:00）里还没过的提醒，按天分组；每条有时刻、标题、提醒方式
// 纪念日（anniversaries）的提醒归 B5（remindAtOf 还不算纪念日），这里只处理日程和待办
import { addDays, msAt, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { applyDnd, remindAtOf, type Dnd } from '../../../../shared/logic/remind.ts';
import { reminderTag } from '../../../../shared/logic/remind-route.ts';

export type RemindKind = 'event' | 'todo';
export type Row = Readonly<Record<string, unknown>> & { readonly id: string };

export const MISSED_DAYS = 7;
export const UPCOMING_DAYS = 7;
const DAY_MS = 86_400_000;
/** “错过的提醒”往回看多久（ms）；收起记录按同一窗口修剪 */
export const MISSED_WINDOW_MS = MISSED_DAYS * DAY_MS;

export interface Reminder {
  readonly kind: RemindKind;
  readonly id: string;
  readonly title: string;
  /** 'chat' = 经 Claude 记下的 */
  readonly source: string;
  /** 本机现算的 remind_at；只有“稍后”没有提醒时刻时为 null */
  readonly remindAt: number | null;
  /** 这一次到点的时刻（已按免打扰推迟） */
  readonly dueAt: number;
  /** 这一次的 due_at 原值（greatest(remind_at, snooze_at, defer_until)，没按本机免打扰推迟）：tag、整页提醒地址里的 due 用它，和服务器推送一致 */
  readonly tagDue: number;
  readonly snoozed: boolean;
  readonly handled: boolean;
  /** "<kind>:<id>:<dueAt>"（tag 里的 dueAt 是没按本机免打扰推迟的那个，和服务器推送的 tag 一致） */
  readonly tag: string;
  readonly row: Row;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isDel = (v: unknown): boolean => v !== null && v !== undefined;

/** 本机现算的 remind_at（日程固定时刻；待办按 current_tz，“其余重算”传这一行的 remind_at） */
export function remindAtLocal(kind: RemindKind, row: Row, now: number, tz: Tz): number | null {
  if (kind === 'event') {
    const date = str(row['date']);
    if (date === null) return null;
    return remindAtOf('event', { date, time: str(row['time']), tz: str(row['tz']), remind_min: num(row['remind_min']), deleted_at: row['deleted_at'] ?? null }, tz, now);
  }
  const prev = 'remind_at' in row ? num(row['remind_at']) : undefined;
  return remindAtOf(
    'todo',
    {
      due: str(row['due']),
      due_time: str(row['due_time']),
      remind_before_min: num(row['remind_before_min']),
      remind_days: num(row['remind_days']),
      remind_time: str(row['remind_time']),
      done: row['done'] === true,
      deleted_at: row['deleted_at'] ?? null,
    },
    tz,
    now,
    prev,
  );
}

/** greatest(remind_at, snooze_at, defer_until)，null 不算；三个都没有返回 null */
export function rawDueAt(remindAt: number | null, row: Row): number | null {
  const xs = [remindAt, num(row['snooze_at']), num(row['defer_until'])].filter((x): x is number => x !== null);
  return xs.length === 0 ? null : Math.max(...xs);
}

/** 一行 → 提醒；不该提醒的（已删、撤销、待办已完成、没有提醒）返回 null */
export function reminderOf(kind: RemindKind, row: Row, now: number, tz: Tz, dnd: Dnd = null): Reminder | null {
  if (isDel(row['deleted_at']) || row['undone'] === true) return null;
  if (kind === 'todo' && row['done'] === true) return null;
  let remindAt: number | null;
  try {
    remindAt = remindAtLocal(kind, row, now, tz);
  } catch {
    return null;   // 日期、时刻格式不对（只读行、坏数据）：不当提醒，不让整张表算不下去
  }
  const raw = rawDueAt(remindAt, row);
  if (raw === null) return null;
  const notified = num(row['notified_for']);
  return {
    kind,
    id: row.id,
    title: str(row['title']) ?? '',
    source: str(row['source']) ?? '',
    remindAt,
    dueAt: applyDnd(raw, tz, dnd),
    tagDue: raw,
    snoozed: num(row['snooze_at']) !== null && num(row['snooze_at']) === raw && raw !== remindAt,
    handled: remindAt !== null ? notified === remindAt : num(row['snooze_at']) === null,
    tag: reminderTag(kind, row.id, raw),
    row,
  };
}

/** 两个集合里所有的提醒 */
export function allReminders(events: readonly Row[], todos: readonly Row[], now: number, tz: Tz, dnd: Dnd = null): Reminder[] {
  const out: Reminder[] = [];
  for (const r of events) {
    const x = reminderOf('event', r, now, tz, dnd);
    if (x) out.push(x);
  }
  for (const r of todos) {
    const x = reminderOf('todo', r, now, tz, dnd);
    if (x) out.push(x);
  }
  return out.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

/** 正在响：本次打开 App 以后到点（dueAt ∈ [since, now]）、没处理、没收起的，先到先出 */
export function ringing(list: readonly Reminder[], now: number, since: number, collapsed: ReadonlySet<string> = new Set()): Reminder[] {
  return list.filter((r) => !r.handled && r.dueAt <= now && r.dueAt >= since && !collapsed.has(r.tag));
}

/** 错过的提醒：最近 7 天里已到点、没处理、不在正在响的队列里的，最近的在前 */
export function missed(list: readonly Reminder[], now: number, ringingTags: ReadonlySet<string> = new Set()): Reminder[] {
  return list
    .filter((r) => !r.handled && r.dueAt <= now && r.dueAt > now - MISSED_DAYS * DAY_MS && !ringingTags.has(r.tag))
    .sort((a, b) => b.dueAt - a.dueAt);
}

/** 提醒方式（未来 7 天清单每条后面那一小段）：词典键和参数 */
export type ModeMsg =
  | { key: 'remind.mode.snoozed'; params: Record<string, never> }
  | { key: 'remind.mode.onTime'; params: Record<string, never> }
  | { key: 'remind.mode.beforeMin'; params: { n: number } }
  | { key: 'remind.mode.beforeHour'; params: { n: number } }
  | { key: 'remind.mode.beforeDay'; params: { n: number } }
  | { key: 'remind.mode.dueBeforeMin'; params: { n: number } }
  | { key: 'remind.mode.dueBeforeHour'; params: { n: number } }
  | { key: 'remind.mode.dueBeforeDay'; params: { n: number } }
  | { key: 'remind.mode.dueOnTime'; params: Record<string, never> }
  | { key: 'remind.mode.sameDay'; params: { time: string } }
  | { key: 'remind.mode.dayBefore'; params: { time: string } };

function beforeMsg(min: number, due: boolean): ModeMsg {
  if (min === 0) return due ? { key: 'remind.mode.dueOnTime', params: {} } : { key: 'remind.mode.onTime', params: {} };
  if (min % 1440 === 0) return { key: due ? 'remind.mode.dueBeforeDay' : 'remind.mode.beforeDay', params: { n: min / 1440 } };
  if (min % 60 === 0) return { key: due ? 'remind.mode.dueBeforeHour' : 'remind.mode.beforeHour', params: { n: min / 60 } };
  return { key: due ? 'remind.mode.dueBeforeMin' : 'remind.mode.beforeMin', params: { n: min } };
}

/** 这一条是怎么提醒的（按“稍后”推迟过的写“稍后再提醒”） */
export function modeOf(r: Reminder): ModeMsg {
  if (r.snoozed) return { key: 'remind.mode.snoozed', params: {} };
  if (r.kind === 'event') return beforeMsg(num(r.row['remind_min']) ?? 0, false);
  if (str(r.row['due_time']) !== null) return beforeMsg(num(r.row['remind_before_min']) ?? 0, true);
  const time = str(r.row['remind_time']) ?? '09:00';
  return num(r.row['remind_days']) === 1 ? { key: 'remind.mode.dayBefore', params: { time } } : { key: 'remind.mode.sameDay', params: { time } };
}

export interface UpcomingDay {
  readonly date: DateStr;
  readonly items: readonly Reminder[];
}

/** 未来 7 天的提醒：今天起 7 天里还没过、没处理的，按天（current_tz）分组 */
export function upcoming(list: readonly Reminder[], now: number, tz: Tz, days: number = UPCOMING_DAYS): UpcomingDay[] {
  const today = todayOf(now, tz);
  const end = msAt(addDays(today, days), 0, tz);
  const byDay = new Map<DateStr, Reminder[]>();
  for (const r of list) {
    if (r.handled || r.dueAt < now || r.dueAt >= end) continue;
    const d = todayOf(r.dueAt, tz);
    const xs = byDay.get(d) ?? [];
    xs.push(r);
    byDay.set(d, xs);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, items]) => ({ date, items }));
}

/** 按 tag 找回一条（整页提醒、横幅用）：kind、id 对得上的那一条；dueAt 不对得上也返回（handled 由调用方看 tag 判断） */
export function findReminder(list: readonly Reminder[], kind: string, id: string): Reminder | undefined {
  return list.find((r) => r.kind === kind && r.id === id);
}
