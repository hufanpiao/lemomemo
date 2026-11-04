// 提醒的数据模型（B2 任务单 FA-4；架构 5.3、5.9“错过的提醒”“未来 7 天的提醒清单”、0.29 P-04、4.6）：纯 TS，不碰 React 和 DOM
// • remind_at 本机现算（TC-B2-29）：用 shared/logic/remind.ts 的 remindAtOf，和服务器（push-dispatch 第 0 步）同一份；
//   待办按“其余重算”传这一行现在的 remind_at（从没同步过、本机没有这一列的不传，走新建时的回落）
// • 这一次到点 due_at = greatest(remind_at, snooze_at, defer_until)（5.3 第 1 步，null 不算）；落在免打扰里的推迟到免打扰结束
//   （本机提醒同样经 applyDnd，remind.ts 文件头）
// • 已处理：notified_for 等于 remind_at（按过“知道了”）；已删、已撤销、待办已完成的不算提醒
// • 正在响（ringing）：本次打开 App 以后到点的、没处理、没收起的；打开前就到点了的进“错过的提醒”（下次打开时在今天页顶部）
// • 错过的提醒（missed，5.9）：最近 7 天里 due_at 已过、没按“知道了”、也不在正在响的队列里（收起的算错过）
// • 未来 7 天（upcoming，TC-B2-66）：今天起 7 天（含今天，到第 7 天 24:00）里还没过的提醒，按天分组；每条有时刻、标题、提醒方式
// • 全天日程（time 为空）：remindAtOf 按 remind_days（0 当天 remind.default_time / 1 前一天 20:00）和 current_tz 算，调用方传 defaultTime
//   （设置 remind.default_time）；提醒方式写“当天 09:00 / 前一天 20:00”（TC-B2-66 全天那一半）
// • 同一次提醒（occurrenceKey，R-336“同一条当天推过就不再响”）：全天日程（没按稍后）按“这一条、这个日期、当天 / 前一天”认，不看时刻——
//   日期变了、前一天 20:00 改成当天提醒，都算另一次（B2 前端增量审查 M1）；
//   按过“知道了”的算已处理（allDayAcked）：当天提醒要 notified_for 落在提醒那天（日期，按现在的 current_tz 算，③），前一天提醒固定 20:00，要正好相等；
//   日期、remind_days 改了，日历编辑在同一次写入里清掉 notified_for、snooze_at（event-edit patchOf），旧的“知道了”套不到新的一次上；
//   本次打开以后响过的（rang），改了 remind.default_time 不再进横幅，没按“知道了”的进“错过的提醒”，显示当时实际响的时刻（②）；
//   有时刻的日程、待办、按了稍后的照旧按 tag。本机通知（local-notify 的 shownKey）用同一套；改了默认时刻，已经弹出的通知不撤回（①）
// 纪念日（anniversaries）的提醒归 B5（remindAtOf 还不算纪念日），这里只处理日程和待办
import { addDays, msAt, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { ALL_DAY_EVE_TIME, allDayTimeOf, applyDnd, remindAtOf, type Dnd } from '../../../../shared/logic/remind.ts';
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

/**
 * 本机现算的 remind_at（有时刻的日程固定时刻；全天日程按 current_tz 和 defaultTime；待办按 current_tz，“其余重算”传这一行的 remind_at）。
 * defaultTime 是设置 remind.default_time 的值（不传按 09:00）
 */
export function remindAtLocal(kind: RemindKind, row: Row, now: number, tz: Tz, defaultTime?: string): number | null {
  if (kind === 'event') {
    const date = str(row['date']);
    if (date === null) return null;
    const ev = { date, time: str(row['time']), tz: str(row['tz']), remind_min: num(row['remind_min']), remind_days: num(row['remind_days']), deleted_at: row['deleted_at'] ?? null };
    return remindAtOf('event', ev, tz, now, undefined, defaultTime);
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
export function reminderOf(kind: RemindKind, row: Row, now: number, tz: Tz, dnd: Dnd = null, defaultTime?: string): Reminder | null {
  if (isDel(row['deleted_at']) || row['undone'] === true) return null;
  if (kind === 'todo' && row['done'] === true) return null;
  let remindAt: number | null;
  try {
    remindAt = remindAtLocal(kind, row, now, tz, defaultTime);
  } catch {
    return null;   // 日期、时刻格式不对（只读行、坏数据）：不当提醒，不让整张表算不下去
  }
  const raw = rawDueAt(remindAt, row);
  if (raw === null) return null;
  const notified = num(row['notified_for']);
  const snoozed = num(row['snooze_at']) !== null && num(row['snooze_at']) === raw && raw !== remindAt;
  // 全天日程（没按稍后）的当天提醒：“知道了”记下的是当时的 remind_at；改了默认时刻以后 remind_at 变了，落在提醒那天就仍算处理过（R-336）。
  // 前一天提醒固定 20:00，notified === remindAt 已经够用，不放宽（审查 M1：免得把当天提醒的“知道了”套到前一天提醒上）
  const day = kind === 'event' && !snoozed ? allDayRemindDay(row) : null;
  const allDayAcked = day !== null && num(row['remind_days']) === 0 && remindAt !== null && notified !== null && todayOf(notified, tz) === day;
  return {
    kind,
    id: row.id,
    title: str(row['title']) ?? '',
    source: str(row['source']) ?? '',
    remindAt,
    dueAt: applyDnd(raw, tz, dnd),
    tagDue: raw,
    snoozed,
    handled: remindAt !== null ? notified === remindAt || allDayAcked : num(row['snooze_at']) === null,
    tag: reminderTag(kind, row.id, raw),
    row,
  };
}

/** 两个集合里所有的提醒；defaultTime 是设置 remind.default_time（全天日程当天提醒用） */
export function allReminders(events: readonly Row[], todos: readonly Row[], now: number, tz: Tz, dnd: Dnd = null, defaultTime?: string): Reminder[] {
  const out: Reminder[] = [];
  for (const r of events) {
    const x = reminderOf('event', r, now, tz, dnd, defaultTime);
    if (x) out.push(x);
  }
  for (const r of todos) {
    const x = reminderOf('todo', r, now, tz, dnd);
    if (x) out.push(x);
  }
  return out.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

/** 全天日程的提醒落在哪天：日期 − remind_days（0 当天 / 1 前一天）；不是全天、没开提醒的返回 null。occurrenceKey、allDayAcked、撤回通知共用（③） */
export function allDayRemindDay(row: Row): DateStr | null {
  const date = str(row['date']);
  const days = num(row['remind_days']);
  if (str(row['time']) !== null || date === null || (days !== 0 && days !== 1)) return null;
  return addDays(date, -days);
}

/**
 * “同一次提醒”的标识（R-336：只对全天日程起作用）：全天日程（没按稍后）是 event:<id>:allday:<日期>:<remind_days>——
 * 改默认时刻是同一次；日期变了、当天 / 前一天换了，是另一次（审查 M1：11-05 当天提醒和 11-06 前一天提醒虽然都落在 11-05，也是两次）；其余就是 tag
 */
export function occurrenceKey(r: Reminder): string {
  if (r.kind !== 'event' || r.snoozed || allDayRemindDay(r.row) === null) return r.tag;
  return `event:${r.id}:allday:${str(r.row['date']) ?? ''}:${String(num(r.row['remind_days']))}`;
}

/** 本次打开以后响过的一次：当时的 tag 和实际响的时刻（dueAt）；旧写法只放 tag */
export interface Rang {
  readonly tag: string;
  readonly dueAt: number;
}
export type RangMap = ReadonlyMap<string, string | Rang>;
const rangTag = (v: string | Rang): string => (typeof v === 'string' ? v : v.tag);

/**
 * 正在响：本次打开 App 以后到点（dueAt ∈ [since, now]）、没处理、没收起的，先到先出。
 * rang：本次打开以后响过的 occurrenceKey → 当时的 tag（和响的时刻）；同一次提醒换了时刻（tag 变了）不再响（R-336）
 */
export function ringing(
  list: readonly Reminder[],
  now: number,
  since: number,
  collapsed: ReadonlySet<string> = new Set(),
  rang: RangMap = new Map(),
): Reminder[] {
  return list.filter((r) => {
    if (r.handled || r.dueAt > now || r.dueAt < since || collapsed.has(r.tag)) return false;
    const before = rang.get(occurrenceKey(r));
    return before === undefined || rangTag(before) === r.tag;
  });
}

/**
 * 错过的提醒：最近 7 天里已到点、没处理、不在正在响的队列里的，最近的在前。
 * rang（R-336 ②）：响过、没按“知道了”、后来改了默认时刻的同一次提醒，不等新时刻，按当时实际响的时刻（dueAt）进来
 */
export function missed(list: readonly Reminder[], now: number, ringingTags: ReadonlySet<string> = new Set(), rang: RangMap = new Map()): Reminder[] {
  return list
    .map((r) => {
      const before = r.handled ? undefined : rang.get(occurrenceKey(r));
      return before !== undefined && typeof before !== 'string' && before.tag !== r.tag ? { ...r, dueAt: before.dueAt } : r;
    })
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

/** 这一条是怎么提醒的（按“稍后”推迟过的写“稍后再提醒”）；全天日程“当天 {default_time} / 前一天 20:00” */
export function modeOf(r: Reminder, defaultTime?: string): ModeMsg {
  if (r.snoozed) return { key: 'remind.mode.snoozed', params: {} };
  if (r.kind === 'event' && str(r.row['time']) === null) {
    return num(r.row['remind_days']) === 1
      ? { key: 'remind.mode.dayBefore', params: { time: ALL_DAY_EVE_TIME } }
      : { key: 'remind.mode.sameDay', params: { time: allDayTimeOf(defaultTime) } };
  }
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
