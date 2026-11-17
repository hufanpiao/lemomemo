// 跨天日程（R-444）：一条日程占哪几天、在某一天是哪一段、那一天怎么写。月历、日清单、周视图（cal-items.ts、week-view.ts）和今天页共用
// • 数据做法：不加列，沿用 events.duration_min（上限 31 天，EVENT_DURATION_MAX）——
//   有时刻的日程是实际经过的分钟（结束 = 开始 + duration_min）；全天日程按“天数 × 1440”记跨几天，≤ 1440 都算一天（旧行、默认的 60 都是一天）
// • 段的写法同周视图的 Cont：'end' = 尾部接着下一天（第一天）、'start' = 头部从前一天接过来（最后一天）、'both' = 中间整天
// • 不带 zod（首屏的今天页、日历用；shared/schema/rows.ts 从这里转出上限给校验用，同 sort-key.ts 的做法）
// 纯函数，“设备当前时区”由调用方传进来
import { addDays, diffDays, minOfDay, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';

/**
 * 日程最多跨几天：定 31 天——一个月的出差、假期都装得下；月历最多 6 周、周视图 7 天，按开始日往前预筛 31 天就够，按天切段的循环也有上限。
 * 和迁移 20261117120000_events_duration_span.sql 的 events_duration_min_check（1～44640）一致
 */
export const EVENT_SPAN_MAX_DAYS = 31;
export const DAY_MINUTES = 1440;
export const EVENT_DURATION_MAX = EVENT_SPAN_MAX_DAYS * DAY_MINUTES;

/** 被午夜切开的一边（周视图的时间块、跨天日程在某一天的那一段共用） */
export type Cont = 'start' | 'end' | 'both';

/** 一条日程占的日子：开始那天、最后一天（含；只占一天时两者相同） */
export interface DaySpan {
  readonly date: DateStr;
  readonly lastDate: DateStr;
}

/** 全天日程跨几天：duration_min ≤ 1440 都算一天，多出来的按整天往上取，最多 31 天 */
export function allDaySpanDays(durationMin: number): number {
  if (!Number.isFinite(durationMin) || durationMin <= DAY_MINUTES) return 1;
  return Math.min(EVENT_SPAN_MAX_DAYS, Math.ceil(durationMin / DAY_MINUTES));
}

/** 有时刻的日程按多少分钟算：坏值、负数按 0，超过上限截到 31 天（库里有约束挡着，这里只防本机坏行把循环拖长） */
export function timedDurationMin(durationMin: number): number {
  return Number.isFinite(durationMin) ? Math.min(EVENT_DURATION_MAX, Math.max(0, Math.trunc(durationMin))) : 0;
}

/** 有时刻的日程结束前那一刻落在 tz 的哪天（结束正好在午夜算前一天；时长 0 的算开始那天） */
export function timedLastDate(startMs: number, endMs: number, tz: Tz): DateStr {
  return todayOf(endMs > startMs ? endMs - 1 : startMs, tz);
}

/** 日程在 day 这一天是哪一段：只占一天的 undefined */
export function contOn(s: DaySpan, day: DateStr): Cont | undefined {
  if (s.date === s.lastDate) return undefined;
  if (day === s.date) return 'end';
  return day === s.lastDate ? 'start' : 'both';
}

/** 日程占的日子里落在 from～to 的那几天（含两头） */
export function spanDaysIn(s: DaySpan, from: DateStr, to: DateStr): DateStr[] {
  const out: DateStr[] = [];
  const last = s.lastDate < to ? s.lastDate : to;
  for (let d = s.date > from ? s.date : from; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 日程占不占 day 这一天 */
export const coversDay = (s: DaySpan, day: DateStr): boolean => s.date <= day && day <= s.lastDate;

/** 有时刻的日程在 day 这一天第几分钟结束：结束不在这一天（还接着下一天）的写 1440 */
export function endMinOn(endMs: number, day: DateStr, tz: Tz): number {
  return todayOf(endMs, tz) === day ? minOfDay(endMs, tz) : DAY_MINUTES;
}

/**
 * 跨天日程在某一天的写法（日清单、今天页共用，各自查自己的词典）：
 * • lead：行首那一格。'start' 写开始时刻；'allDay' 写“全天”；'ongoing' 写“持续”（中间整天）；'until' 写“至 HH:MM”（最后一天，endMin）
 * • meta：标题后面的小字。'untilDate' 写“至 11月20日 18:00”（有时刻、还没到最后一天）；'dayOf' 写“第 2/3 天”（跨天的全天日程）；只占一天的 null
 */
export interface SpanText {
  readonly lead: 'start' | 'allDay' | 'ongoing' | 'until';
  /** 这一天里第几分钟结束（还接着下一天的是 1440）；全天日程为 null */
  readonly endMin: number | null;
  readonly meta: null | { readonly kind: 'untilDate'; readonly date: DateStr; readonly endMin: number } | { readonly kind: 'dayOf'; readonly index: number; readonly days: number };
}

/** endMs 为 null 当全天日程 */
export function spanTextOn(s: DaySpan & { readonly endMs: number | null }, day: DateStr, tz: Tz): SpanText {
  const cont = contOn(s, day);
  if (s.endMs === null) {
    return { lead: 'allDay', endMin: null, meta: cont === undefined ? null : { kind: 'dayOf', index: diffDays(s.date, day) + 1, days: diffDays(s.date, s.lastDate) + 1 } };
  }
  const endMin = endMinOn(s.endMs, day, tz);
  const untilDate = { kind: 'untilDate' as const, date: s.lastDate, endMin: endMinOn(s.endMs, s.lastDate, tz) };
  if (cont === undefined) return { lead: 'start', endMin, meta: null };
  if (cont === 'end') return { lead: 'start', endMin, meta: untilDate };
  return cont === 'both' ? { lead: 'ongoing', endMin, meta: untilDate } : { lead: 'until', endMin, meta: null };
}
