// 提醒时刻（架构 0.29 P-04、续第 124 条②（R-183）、4.6 时区规则；TC-B2-72）：remind_at 是派生列，客户端本机现算、服务器（push-dispatch 第 0 步）
// 重算都用这一份，两边算出来一样。纯函数：不读设置、不碰 DOM、不看进程时区，“现在”由调用方传 now（A15：tz 必填）。
//
// 待办（浮动时刻，按 current_tz）：
//   • 没截止日、已完成、已删除 → 不提醒（null）；
//   • due_time 为空 → 照旧按 remind_days（0 当天 / 1 前一天；null 不提醒）+ remind_time（默认 09:00）；
//   • due_time 不为空 → 截止时刻 = due + due_time；remind_before_min 为 null 不提醒；否则提醒 = 截止 − 提前量：
//       “1 天”（1440）按墙上时间退到前一天的同一时刻（夏令时切换那天也是“昨天 17:00”），其余提前量按实际经过的分钟往前减；
//       算出的时刻已过时，分两种（代码审查 BE-1 M2，11-03 主持人定口径）：
//       ① 不传 prevRemindAt（新建、改了 due / due_time / remind_before_min）：截止还没到 → 在截止时刻提醒；截止也过了 → 不提醒
//          （正好等于截止时刻仍在截止时刻提醒）。这是 0.29 续第 124 条② 的“回落”，只在这时发生；
//       ② 传了 prevRemindAt（其余一切重算：push-dispatch 第 0 步、打勾 / 取消打勾、按“稍后”、改别的触发列、换时区，传这一行现在的
//          remind_at，可以是 null）：不再回落——原来已经回落到截止时刻的（prevRemindAt 等于截止时刻）保持截止时刻，否则原样返回算出的
//          （已过的）时刻。这样 16:01 按“稍后”写 snooze_at = 16:11 后重算 remind_at 仍是 16:00，due_at = greatest(16:00, 16:11) = 16:11 照常响；
//          取消打勾也不会多出一次截止时刻的提醒。
//     新建或第一次设 due_time 时提前量默认 60（remindBeforeOnSetDueTime，编辑页、AI 保存时用）。
// 日程（固定时刻）：有具体时间的按日程自己的 tz，msAt(date, time − remind_min, tz)，换了地方也不变。
//   全天日程（按 remind_days 和 remind.default_time）、纪念日不在 B2 第一天派工表第 5 行的范围，这里先返回 null，由后续一段补。
// 免打扰不并进 remind_at：架构 5.3 第 2 步在发送时判断，落在免打扰里的写 defer_until = 免打扰结束（dndDeferUntil）；
//   本机提醒同样经 applyDnd 推迟（可能晚于截止，R-183 接受）。
import { addDays, minOfDay, msAt, parseHm, todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';

/** 编辑页“提前提醒”的选项（分钟）：准时 / 10 分钟 / 30 分钟 / 1 小时 / 2 小时 / 1 天；和 todos.remind_before_min 的 check 约束一致 */
export const REMIND_BEFORE_CHOICES: readonly number[] = [0, 10, 30, 60, 120, 1440];
/** 新建或第一次设 due_time 时的提前量 */
export const DEFAULT_REMIND_BEFORE_MIN = 60;
/** 待办 remind_time 为空时的提醒时刻 */
export const DEFAULT_TODO_REMIND_TIME = '09:00';

const MIN_MS = 60_000;
const DAY_MIN = 1440;

export interface TodoRemindRow {
  due: DateStr | null;
  due_time: string | null;
  remind_before_min: number | null;
  remind_days: number | null;
  remind_time: string | null;
  done?: boolean | null;
  deleted_at?: unknown;
}

export interface EventRemindRow {
  date: DateStr;
  time: string | null;
  tz: Tz | null;
  remind_min: number | null;
  deleted_at?: unknown;
}

/** 免打扰时段（current_tz 的墙上时间，HH:MM）；end 早于 start 表示跨午夜；null 或 start = end 表示没开 */
export type Dnd = { start: string; end: string } | null;

const deleted = (v: unknown): boolean => v !== null && v !== undefined;

/** 第一次设 due_time（原来没有）时提前量用默认 60；原来已有 due_time 时保留原来的（含 null = 不提醒） */
export function remindBeforeOnSetDueTime(prevDueTime: string | null, prevBefore: number | null): number | null {
  return prevDueTime === null ? DEFAULT_REMIND_BEFORE_MIN : prevBefore;
}

/**
 * 待办的提醒时刻（毫秒）；null = 不提醒。tz 是 current_tz。
 * prevRemindAt：新建、改了截止日期 / 截止时刻 / 提前量时不传（undefined）；其余重算传这一行现在的 remind_at（null 也要传）。见文件头 ①②
 */
export function todoRemindAt(row: TodoRemindRow, tz: Tz, now: number, prevRemindAt?: number | null): number | null {
  if (row.due === null || row.done === true || deleted(row.deleted_at)) return null;
  if (row.due_time === null) {
    if (row.remind_days !== 0 && row.remind_days !== 1) return null;
    return msAt(addDays(row.due, -row.remind_days), parseHm(row.remind_time ?? DEFAULT_TODO_REMIND_TIME), tz);
  }
  const before = row.remind_before_min;
  if (before === null) return null;
  const dueMin = parseHm(row.due_time);
  const dueAt = msAt(row.due, dueMin, tz);
  const remind = before === DAY_MIN ? msAt(addDays(row.due, -1), dueMin, tz) : dueAt - before * MIN_MS;
  if (remind >= now) return remind;
  if (prevRemindAt === undefined) return dueAt >= now ? dueAt : null;   // ① 新建或改了时刻：回落
  return prevRemindAt === dueAt ? dueAt : remind;                       // ② 其余重算：不回落，保留原来的
}

/** 有具体时间的日程（固定时刻）的提醒时刻；全天日程、没设提醒、缺 tz、已删除返回 null */
export function eventRemindAt(row: EventRemindRow): number | null {
  if (row.time === null || row.tz === null || row.remind_min === null || deleted(row.deleted_at)) return null;
  return msAt(row.date, parseHm(row.time), row.tz) - row.remind_min * MIN_MS;
}

export function remindAtOf(kind: 'todo', row: TodoRemindRow, tz: Tz, now: number, prevRemindAt?: number | null): number | null;
export function remindAtOf(kind: 'event', row: EventRemindRow, tz: Tz, now: number, prevRemindAt?: number | null): number | null;
/**
 * 按类型分派（push-dispatch 第 0 步和客户端保存时用）；tz 是 current_tz（固定时刻的日程不用它）。
 * prevRemindAt 只对待办有意义（日程是固定时刻，没有回落，传了也不看）：新建、改了截止或提前量不传，其余重算传这一行现在的 remind_at
 */
export function remindAtOf(kind: 'todo' | 'event', row: TodoRemindRow | EventRemindRow, tz: Tz, now: number, prevRemindAt?: number | null): number | null {
  return kind === 'todo' ? todoRemindAt(row as TodoRemindRow, tz, now, prevRemindAt) : eventRemindAt(row as EventRemindRow);
}

/** 时刻 ms 落在免打扰里时返回免打扰结束的时刻，不在时返回 null。开始时刻算在里面，结束时刻不算 */
export function dndDeferUntil(ms: number, tz: Tz, dnd: Dnd): number | null {
  if (dnd === null) return null;
  const s = parseHm(dnd.start);
  const e = parseHm(dnd.end);
  if (s === e) return null;
  const m = minOfDay(ms, tz);
  const day = todayOf(ms, tz);
  if (s < e) return m >= s && m < e ? msAt(day, e, tz) : null;
  if (m >= s) return msAt(addDays(day, 1), e, tz);
  return m < e ? msAt(day, e, tz) : null;
}

/** 落在免打扰里就推迟到结束，否则原样 */
export function applyDnd(ms: number, tz: Tz, dnd: Dnd): number {
  return dndDeferUntil(ms, tz, dnd) ?? ms;
}
