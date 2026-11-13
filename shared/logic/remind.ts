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
// 全天日程（浮动时刻，按 current_tz，架构 4.6 第 2739 行）：time 为空，按 remind_days（数据字典 4.8 第 358 行：in (0, 1)，0 当天、1 前一天；
//   null 不提醒，其余值不合约束、不提醒）——
//   • 0 = 当天的 remind.default_time（调用方传 defaultTime；没设、认不出按出厂 09:00；架构 0.29 续第 47、57 条 第 960、970 行）；
//   • 1 = 前一天 20:00（v3 已定“全天日程：不提醒 / 当天 9:00 / 前一天 20:00”，需求澄清-v3 第 7 行、修改清单-v3 第 7 行；
//     v4 架构 0.29 续第 45、47 条 第 958、960 行和 TC-B2-63④ 沿用“前一天 20:00”，没说改成 default_time）。
//   已过时不回落：和没有截止时刻的待办一样原样返回算出的时刻（传不传 prevRemindAt 一样），到没到点、过了多久由调用方的窗口判断
//   （push-dispatch 第 1 步 due_at > now − 60 分钟）。口径见架构 5.3 第 4 步（11-04）：全天日程已过时不回落、不补推，
//   和“待办 due_time 为空”一样；推迟、晚到的提醒文案按这一次提醒落在哪天写（R-333、R-334）。
// 纪念日归 B5（logic/anniv），这里不算。
// 免打扰不并进 remind_at：架构 5.3 第 2 步在发送时判断，落在免打扰里的写 defer_until = 免打扰结束（dndDeferUntil）；
//   本机提醒同样经 applyDnd 推迟（可能晚于截止，R-183 接受）。
import { addDays, minOfDay, msAt, parseHm, todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';

/**
 * 提醒规则版本号（R-411，方案-提醒队列重写 3.3④）：本文件的算法结果一变就加 1，同时更新 tests/build/remind-rules-ver.snap.json，
 * 并写一行迁移 `select private.remind_enqueue('all', null, null, null, false, <新版本>::smallint)`（全量重算，旧版 push-dispatch 拿不到这些项）。
 * 三处由 tests/build/remind-rules-ver.test.ts 核对
 */
export const REMIND_RULES_VER = 1;

/** 编辑页“提前提醒”的选项（分钟）：准时 / 10 分钟 / 30 分钟 / 1 小时 / 2 小时 / 1 天；和 todos.remind_before_min 的 check 约束一致 */
export const REMIND_BEFORE_CHOICES: readonly number[] = [0, 10, 30, 60, 120, 1440];
/** 新建或第一次设 due_time 时的提前量 */
export const DEFAULT_REMIND_BEFORE_MIN = 60;
/**
 * 出厂提醒时刻（只有这一份）：待办 remind_time 为空、remind.default_time（全天日程当天提醒、全天日程的“开始”）没设、
 * anniv.default_time（纪念日）没设或认不出，都按它。待办“明天再提醒”的固定时刻另见 remind-actions.ts 的 TOMORROW_TIME
 */
export const DEFAULT_REMIND_TIME = '09:00';
/** 全天日程前一天提醒的时刻（v3 已定，v4 架构 0.29 续第 45、47 条沿用） */
export const ALL_DAY_EVE_TIME = '20:00';
/** 拿不到 remind.default_time 时判断全天日程当天提醒“还会不会响”用的退路：当天结束前都算会响（架构 5.3 第 4 步（11-04）；日历编辑、今天页共用） */
export const ALL_DAY_LIVE_UNTIL = '23:59';

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
  /** 全天日程：0 当天、1 前一天；null 不提醒（有时刻的日程不看这一列） */
  remind_days?: number | null;
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
    return msAt(addDays(row.due, -row.remind_days), parseHm(row.remind_time ?? DEFAULT_REMIND_TIME), tz);
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

const HM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** remind.default_time 的值 → HH:MM；没设、不是字符串、格式不对都按出厂 09:00 */
export function allDayTimeOf(defaultTime: unknown): string {
  return typeof defaultTime === 'string' && HM.test(defaultTime) ? defaultTime : DEFAULT_REMIND_TIME;
}

/** 全天日程（浮动，按 current_tz）的提醒时刻；remind_days 为 null 或不是 0 / 1、已删除返回 null。见文件头 */
export function allDayRemindAt(row: EventRemindRow, tz: Tz, defaultTime?: unknown): number | null {
  if (row.time !== null || deleted(row.deleted_at)) return null;
  const days = row.remind_days ?? null;
  if (days === 0) return msAt(row.date, parseHm(allDayTimeOf(defaultTime)), tz);
  if (days === 1) return msAt(addDays(row.date, -1), parseHm(ALL_DAY_EVE_TIME), tz);
  return null;
}

/**
 * 日程的提醒时刻。有具体时间的（固定时刻）按日程自己的 tz，没设提醒、缺 tz、已删除返回 null；
 * 全天日程要传 tz（current_tz）和 defaultTime（设置 remind.default_time），不传 tz 时返回 null（兼容只传一行的旧调用）
 */
export function eventRemindAt(row: EventRemindRow, tz?: Tz, defaultTime?: unknown): number | null {
  if (row.time === null) return tz === undefined ? null : allDayRemindAt(row, tz, defaultTime);
  if (row.tz === null || row.remind_min === null || deleted(row.deleted_at)) return null;
  return msAt(row.date, parseHm(row.time), row.tz) - row.remind_min * MIN_MS;
}

export function remindAtOf(kind: 'todo', row: TodoRemindRow, tz: Tz, now: number, prevRemindAt?: number | null): number | null;
export function remindAtOf(kind: 'event', row: EventRemindRow, tz: Tz, now: number, prevRemindAt?: number | null, defaultTime?: unknown): number | null;
/**
 * 按类型分派（push-dispatch 第 0 步和客户端保存时用）；tz 是 current_tz（有时刻的日程不用它，全天日程用它）。
 * prevRemindAt 只对待办有意义（日程没有回落，传了也不看）：新建、改了截止或提前量不传，其余重算传这一行现在的 remind_at。
 * defaultTime 是设置 remind.default_time 的值（只有全天日程当天提醒用；不传、认不出按 09:00）
 */
export function remindAtOf(
  kind: 'todo' | 'event',
  row: TodoRemindRow | EventRemindRow,
  tz: Tz,
  now: number,
  prevRemindAt?: number | null,
  defaultTime?: unknown,
): number | null {
  return kind === 'todo' ? todoRemindAt(row as TodoRemindRow, tz, now, prevRemindAt) : eventRemindAt(row as EventRemindRow, tz, defaultTime);
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

/**
 * 全天日程的提醒落在哪天：日期 − remind_days（0 当天 / 1 前一天）；不是全天、没开提醒的返回 null。
 * 前端的 occurrenceKey、allDayAcked、撤回通知共用（③；11-04 从 src/features/reminders/data/reminder-model.ts 挪来，那边原地转发导出）。
 * “是不是全天日程”的条件和 shared/logic/remind-route.ts 的 isAllDayRemind 一致（那个文件不准 import，各写一份；tests/shared/occurrence-key.test.ts 核对）
 */
export function allDayRemindDay(row: Readonly<Record<string, unknown>>): DateStr | null {
  const date = row['date'];
  const days = row['remind_days'];
  if (typeof row['time'] === 'string' || typeof date !== 'string' || (days !== 0 && days !== 1)) return null;
  return addDays(date, -days);
}

/**
 * R-336“同一条当天推过就不再响”的“同一天”（REMIND-shown-persist S2，11-05；方案 docs/03-评审/B2/B2-方案-提醒响过持久化.md 第 7 节）：
 * at（pushed_for、notified_for 这类记下的时刻）是数字，并且按 tz 和 remindAt（这一次重算出的提醒时刻）落在同一天。
 * push-dispatch 第 0 步判“这一天已经提醒过”、前端判“这一次响过 / 已处理”都调这一份（原来第 0 步里内联写 dayOf(x) === dayOf(remindAt)）；
 * remind_days 是 0 还是 1 都按天比（服务器口径，方案第 5 节：前一天提醒也按天比，换了时区不多响）
 */
export function sameRemindDay(at: unknown, remindAt: number, tz: Tz): boolean {
  return typeof at === 'number' && todayOf(at, tz) === todayOf(remindAt, tz);
}
