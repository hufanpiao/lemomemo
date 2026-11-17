// 跨天日程（R-444）：一条日程放在设备时区的哪几天、在某一天是哪一段、那一天怎么写。
// “这条日程覆盖哪些天”只在这里算（placeEvent）：月历、日清单、周视图、今天页、提醒全屏页、编辑页、找候选、本机查找都用它，回落规则只有一套：
// • 日期坏了、时刻格式坏了 → null（调用方跳过这一条，不让整页算不出来）；time 为 null（或不是字符串）→ 全天；
// • events.tz 不是有效的时区名或缺失 → 当作设备时区（TZ-invalid-b2）；
// • 时长不是 1～EVENT_DURATION_MAX 的整数 → 按 EVENT_DURATION_DEFAULT（1 小时）。
// 数据做法：不加列，沿用 events.duration_min（上限 31 天）——有时刻的日程是实际经过的分钟（结束 = 开始 + duration_min）；
//   全天日程按“天数 × 1440”记跨几天，≤ 1440 都算一天（旧行、默认的 60 都是一天），只占一天的写 EVENT_DURATION_DEFAULT（allDayDuration）
// 段的写法同周视图的 Cont：'end' = 尾部接着下一天（第一天）、'start' = 头部从前一天接过来（最后一天）、'both' = 中间整天
// 不带 zod（首屏的今天页、日历用；shared/schema/rows.ts 从这里转出上限给校验用，同 sort-key.ts 的做法）。纯函数，“设备当前时区”由调用方传进来
import { addDays, DAY_MINUTES, diffDays, hm24, minOfDay, msAt, parseDate, parseHm, todayOf, type DateStr } from '../../core/date.ts';
import { isValidTz, type Tz } from '../../core/tz.ts';

/**
 * 日程最多跨几天：定 31 天——一个月的出差、假期都装得下；月历最多 6 周、周视图 7 天，按开始日往前预筛 31 天就够，按天切段的循环也有上限。
 * 和迁移 20261117120000_events_duration_span.sql 的 events_duration_min_check（1～44640）一致
 */
export const EVENT_SPAN_MAX_DAYS = 31;
export const EVENT_DURATION_MAX = EVENT_SPAN_MAX_DAYS * DAY_MINUTES;
/** 默认时长（新建、没说时长、坏值回落、只占一天的全天日程）：1 小时 */
export const EVENT_DURATION_DEFAULT = 60;

/** 被午夜切开的一边（周视图的时间块、跨天日程在某一天的那一段共用） */
export type Cont = 'start' | 'end' | 'both';

/** 一条日程占的日子：开始那天、最后一天（含；只占一天时两者相同） */
export interface DaySpan {
  readonly date: DateStr;
  readonly lastDate: DateStr;
}

/** placeEvent 要的几列（events 行、编辑页表单、提醒的行都有） */
export interface SpanRow {
  readonly date: string;
  readonly time: string | null;
  readonly tz: string | null;
  readonly duration_min: number;
}

/** 日程放在设备时区的哪几天、几点 */
export type EventPlacement =
  | (DaySpan & { readonly allDay: true })
  | (DaySpan & {
      readonly allDay: false;
      /** 开始、结束的绝对时刻（毫秒） */
      readonly startMs: number;
      readonly endMs: number;
      /** 设备时区里开始是当天第几分钟 */
      readonly startMin: number;
    });

/** 时长：1～EVENT_DURATION_MAX 的整数照用，其余（坏值、0、超上限）按 EVENT_DURATION_DEFAULT */
export function eventDurationMin(durationMin: number): number {
  return Number.isInteger(durationMin) && durationMin >= 1 && durationMin <= EVENT_DURATION_MAX ? durationMin : EVENT_DURATION_DEFAULT;
}

/** 全天日程跨几天：≤ 1440（含坏值回落的默认值）算一天，多出来的按整天往上取 */
export function allDaySpanDays(durationMin: number): number {
  return Math.ceil(eventDurationMin(durationMin) / DAY_MINUTES);
}

/**
 * 全天日程跨 days 天时存的时长：一天写默认值，多天写“天数 × 1440”（1～31 天）。
 * 超过 31 天的悄悄截到 31 天，和有时刻的（event-edit.ts 的 durationTo 原样返回、写入校验拒收）口径不同，是有意的：
 * 全天只有“最后一天”一个量，编辑页日期框 max 已限在 31 天，到这里还超的只会是 AI 或坏值，截短照样存下这条；
 * 有时刻的时长是用户选的结束日期加时刻直接算出来的，截短等于悄悄改掉用户选的结束时刻，所以宁可拒收、提示
 */
export function allDayDuration(days: number): number {
  const n = Math.min(EVENT_SPAN_MAX_DAYS, Math.max(1, Math.trunc(days)));
  return n === 1 ? EVENT_DURATION_DEFAULT : n * DAY_MINUTES;
}

/** 本机缓存、提醒里的一行（列类型没保证）→ SpanRow；没有日期为 null */
export function spanRowOf(r: Readonly<Record<string, unknown>>): SpanRow | null {
  const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const date = s(r['date']);
  if (date === null) return null;
  return { date, time: s(r['time']), tz: s(r['tz']), duration_min: typeof r['duration_min'] === 'number' ? r['duration_min'] : NaN };
}

/** 日程按哪个时区算开始时刻：自己的 tz 有效就用它，缺失或无效（TZ-invalid-b2）按 device。placeEvent、编辑页、今天页的“原时区几点”共用 */
export function ownTzOf(tz: string | null, device: Tz): Tz {
  return tz !== null && isValidTz(tz) ? tz : device;
}

function okDate(s: string): boolean {
  try {
    parseDate(s);
    return true;
  } catch {
    return false;
  }
}

/** 日程按 4.6 放进设备时区 tz 的哪几天（回落规则见文件头） */
export function placeEvent(ev: SpanRow, tz: Tz): EventPlacement | null {
  if (!okDate(ev.date)) return null;
  if (ev.time === null) return { allDay: true, date: ev.date, lastDate: addDays(ev.date, allDaySpanDays(ev.duration_min) - 1) };
  let startMs: number;
  try {
    startMs = msAt(ev.date, parseHm(ev.time), ownTzOf(ev.tz, tz));
  } catch {
    return null;
  }
  const endMs = startMs + eventDurationMin(ev.duration_min) * 60_000;
  // 最后一天 = 结束前一刻落在哪天（结束正好在午夜算前一天）
  return { allDay: false, date: todayOf(startMs, tz), lastDate: todayOf(endMs - 1, tz), startMs, endMs, startMin: minOfDay(startMs, tz) };
}

/** 日程在 day 这一天是哪一段：只占一天的 undefined */
export function contOn(s: DaySpan, day: DateStr): Cont | undefined {
  if (s.date === s.lastDate) return undefined;
  if (day === s.date) return 'end';
  return day === s.lastDate ? 'start' : 'both';
}

/** 跨天的日程 day 这一天是第几天、共几天（周视图全天行“(2/3)”、日清单“第 2/3 天”共用）；只占一天的 undefined */
export function dayOfSpan(s: DaySpan, day: DateStr): { readonly index: number; readonly days: number } | undefined {
  return s.date === s.lastDate ? undefined : { index: diffDays(s.date, day) + 1, days: diffDays(s.date, s.lastDate) + 1 };
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

/** 日程和 from～to 有没有交叠（含两头） */
export const overlapsDays = (s: DaySpan, from: DateStr, to: DateStr): boolean => s.date <= to && s.lastDate >= from;

/** 有时刻的日程在 day 这一天第几分钟结束：结束不在这一天（还接着下一天）的写 1440 */
export function endMinOn(endMs: number, day: DateStr, tz: Tz): number {
  return todayOf(endMs, tz) === day ? minOfDay(endMs, tz) : DAY_MINUTES;
}

/** 跨天日程的几句话：词条键 + 参数（键在公共词典 shared/i18n/zh.ts、ko.ts 的 span.*，src/kit/hooks/useSpanT.ts 翻译；日清单、今天页、全屏提醒页共用一套） */
export type SpanMsg =
  | { readonly key: 'span.allDay' | 'span.ongoing'; readonly params: Record<string, never> }
  | { readonly key: 'span.until'; readonly params: { readonly t: string } }
  | { readonly key: 'span.untilDate'; readonly params: { readonly m: number; readonly d: number; readonly t: string } }
  | { readonly key: 'span.dayOf'; readonly params: { readonly i: number; readonly n: number } };

/**
 * 日程在某一天的写法（日清单、今天页共用）：
 * • lead：行首那一格。'start' 由调用方写开始时刻；其余是 SpanMsg：全天日程“全天”，跨天的后几天中间整天“持续”、最后一天“至 18:00”
 * • meta：标题后面的小字。有时刻、还没到最后一天的“至 11月20日 18:00”；跨天的全天日程“第 2/3 天”；只占一天的 null
 * • endMin：这一天里第几分钟结束（还接着下一天的是 1440）；全天日程为 null（行首按它上“已过去”的颜色）
 */
export interface SpanText {
  readonly lead: 'start' | SpanMsg;
  readonly endMin: number | null;
  readonly meta: SpanMsg | null;
}

/** 某一段的结束：同一天“至 18:00”、结束在后面某天“至 11月20日 18:00”（全屏提醒页副标题、日清单标题下的小字共用） */
export function untilMsg(s: DaySpan & { readonly endMs: number }, tz: Tz): SpanMsg {
  const t = hm24(endMinOn(s.endMs, s.lastDate, tz));
  if (s.date === s.lastDate) return { key: 'span.until', params: { t } };
  const { m, d } = parseDate(s.lastDate);
  return { key: 'span.untilDate', params: { m, d, t } };
}

/** 日程（placeEvent 的结果）在 day 这一天怎么写 */
export function spanTextOn(s: EventPlacement, day: DateStr, tz: Tz): SpanText {
  if (s.allDay) {
    const of = dayOfSpan(s, day);
    return { lead: { key: 'span.allDay', params: {} }, endMin: null, meta: of ? { key: 'span.dayOf', params: { i: of.index, n: of.days } } : null };
  }
  const cont = contOn(s, day);
  const endMin = endMinOn(s.endMs, day, tz);
  if (cont === undefined) return { lead: 'start', endMin, meta: null };
  if (cont === 'start') return { lead: { key: 'span.until', params: { t: hm24(endMin) } }, endMin, meta: null };
  return { lead: cont === 'both' ? { key: 'span.ongoing', params: {} } : 'start', endMin, meta: untilMsg(s, tz) };
}
