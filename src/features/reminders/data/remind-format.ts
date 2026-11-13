// 提醒界面上的几段说明文字（B2 FA-4；线框 s1b）：只返回词典键和参数，界面再翻译（2.4 第 3 点）。纯 TS
// • 日程：“15 分钟后开始”（< 60 分钟）、“15:30 开始”、“已经开始”
// • 待办：“今天 17:00 截止”“今天截止”“11月5日截止”“已过截止”“没有截止日期”
// • 错过的提醒每行：“今天 09:00 · 日程”（day、time、kind）
import { addDays, diffDays, msAt, parseDate, parseHm, todayOf, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { hhmm } from '../../../../shared/logic/notify-text.ts';
import { startAtOf } from '../../../../shared/logic/remind-actions.ts';
import type { Reminder } from './reminder-model.ts';

export type WhenMsg =
  | { key: 'remind.when.startIn'; params: { n: number } }
  | { key: 'remind.when.startAt'; params: { time: string } }
  | { key: 'remind.when.started'; params: Record<string, never> }
  | { key: 'remind.when.dueToday'; params: Record<string, never> }
  | { key: 'remind.when.dueAt'; params: { time: string } }
  | { key: 'remind.when.dueOn'; params: { m: number; d: number } }
  | { key: 'remind.when.overdue'; params: Record<string, never> }
  | { key: 'remind.when.noDue'; params: Record<string, never> }
  | { key: 'remind.when.annivToday' | 'remind.when.annivTomorrow' | 'remind.when.annivPast'; params: Record<string, never> }
  | { key: 'remind.when.annivIn'; params: { n: number } };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 纪念日（B5 S15）：“今天就是 / 明天 / 7 天后”（按这次提醒对应的那一次纪念日 annivDate；过了写“已经过了”） */
function annivWhen(r: Reminder, now: number, tz: Tz): WhenMsg {
  const n = r.annivDate === undefined ? 0 : diffDays(todayOf(now, tz), r.annivDate);
  if (n < 0) return { key: 'remind.when.annivPast', params: {} };
  if (n === 0) return { key: 'remind.when.annivToday', params: {} };
  if (n === 1) return { key: 'remind.when.annivTomorrow', params: {} };
  return { key: 'remind.when.annivIn', params: { n } };
}

/** 日程的开始时刻（全天按 remind.default_time） */
export function eventStart(r: Reminder, tz: Tz, defaultTime?: string): number | null {
  const date = str(r.row['date']);
  if (date === null) return null;
  return startAtOf({ date, time: str(r.row['time']), tz: str(r.row['tz']) }, tz, defaultTime);
}

export function whenMsg(r: Reminder, now: number, tz: Tz, defaultTime?: string): WhenMsg {
  if (r.kind === 'anniv') return annivWhen(r, now, tz);
  if (r.kind === 'event') {
    const s = eventStart(r, tz, defaultTime);
    if (s === null) return { key: 'remind.when.started', params: {} };
    if (s <= now) return { key: 'remind.when.started', params: {} };
    const min = Math.ceil((s - now) / 60_000);
    return min < 60 ? { key: 'remind.when.startIn', params: { n: min } } : { key: 'remind.when.startAt', params: { time: hhmm(s, tz) } };
  }
  const due = str(r.row['due']);
  if (due === null) return { key: 'remind.when.noDue', params: {} };
  const dueTime = str(r.row['due_time']);
  const today = todayOf(now, tz);
  const end = dueTime !== null ? msAt(due, parseHm(dueTime), tz) : msAt(addDays(due, 1), 0, tz);
  if (end <= now) return { key: 'remind.when.overdue', params: {} };
  if (due === today) return dueTime !== null ? { key: 'remind.when.dueAt', params: { time: dueTime } } : { key: 'remind.when.dueToday', params: {} };
  const { m, d } = parseDate(due);
  return { key: 'remind.when.dueOn', params: { m, d } };
}

/**
 * 整页提醒的类型行（设计复审 今天页待办 M3；线框 FULLALERT）：写“还有多久”，不再写一遍下面大号字的时刻。
 * • 日程：没开始写“15 分钟后开始”“2 小时 5 分钟后开始”“3 天后开始”；开始了写“刚刚开始”“已经开始 5 分钟”“已经开始 2 小时”“已经开始 1 天”（满 24 小时按天）
 * • 待办有截止时刻：“40 分钟后截止”“1 小时后截止”“2 天后截止”，过了写“已过截止”；只有截止日期、没有截止日期的照 whenMsg
 */
export type RelMsg =
  | { key: 'remind.rel.startInMin' | 'remind.rel.dueInMin' | 'remind.rel.startedMin'; params: { n: number } }
  | { key: 'remind.rel.startInH' | 'remind.rel.dueInH' | 'remind.rel.startedH'; params: { h: number } }
  | { key: 'remind.rel.startInHM' | 'remind.rel.dueInHM'; params: { h: number; m: number } }
  | { key: 'remind.rel.startInD' | 'remind.rel.dueInD' | 'remind.rel.startedD'; params: { n: number } }
  | { key: 'remind.rel.startedNow'; params: Record<string, never> }
  | WhenMsg;

const DAY_MIN = 24 * 60;

/** 还有 min 分钟（≥ 1）：分钟、小时（零头分钟写上，整点不写）、天（满 24 小时按整天往下取） */
function ahead(min: number, k: 'start' | 'due'): RelMsg {
  if (min < 60) return { key: k === 'start' ? 'remind.rel.startInMin' : 'remind.rel.dueInMin', params: { n: min } };
  if (min < DAY_MIN) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (m === 0) return { key: k === 'start' ? 'remind.rel.startInH' : 'remind.rel.dueInH', params: { h } };
    return { key: k === 'start' ? 'remind.rel.startInHM' : 'remind.rel.dueInHM', params: { h, m } };
  }
  return { key: k === 'start' ? 'remind.rel.startInD' : 'remind.rel.dueInD', params: { n: Math.floor(min / DAY_MIN) } };
}

export function relMsg(r: Reminder, now: number, tz: Tz, defaultTime?: string): RelMsg {
  if (r.kind === 'anniv') return annivWhen(r, now, tz);
  if (r.kind === 'event') {
    const s = eventStart(r, tz, defaultTime);
    if (s === null) return { key: 'remind.when.started', params: {} };
    if (s > now) return ahead(Math.ceil((s - now) / 60_000), 'start');
    const past = Math.floor((now - s) / 60_000);
    if (past < 1) return { key: 'remind.rel.startedNow', params: {} };
    if (past < 60) return { key: 'remind.rel.startedMin', params: { n: past } };
    if (past < DAY_MIN) return { key: 'remind.rel.startedH', params: { h: Math.floor(past / 60) } };
    // 满 24 小时按整天往下取（代码复审 N3：不写“已经开始 25 小时”）
    return { key: 'remind.rel.startedD', params: { n: Math.floor(past / DAY_MIN) } };
  }
  const due = str(r.row['due']);
  const dueTime = str(r.row['due_time']);
  if (due === null || dueTime === null) return whenMsg(r, now, tz, defaultTime);
  const end = msAt(due, parseHm(dueTime), tz);
  if (end <= now) return { key: 'remind.when.overdue', params: {} };
  return ahead(Math.ceil((end - now) / 60_000), 'due');
}

export type DayMsg =
  | { key: 'remind.day.today'; params: Record<string, never> }
  | { key: 'remind.day.yesterday'; params: Record<string, never> }
  | { key: 'remind.day.tomorrow'; params: Record<string, never> }
  | { key: 'remind.day.date'; params: { m: number; d: number } };

/** 某一天相对今天怎么说 */
export function dayMsg(date: DateStr, today: DateStr): DayMsg {
  const n = diffDays(today, date);
  if (n === 0) return { key: 'remind.day.today', params: {} };
  if (n === -1) return { key: 'remind.day.yesterday', params: {} };
  if (n === 1) return { key: 'remind.day.tomorrow', params: {} };
  const { m, d } = parseDate(date);
  return { key: 'remind.day.date', params: { m, d } };
}

export type WdKey = `remind.wd.${0 | 1 | 2 | 3 | 4 | 5 | 6}`;
export function wdKey(date: DateStr): WdKey {
  return `remind.wd.${weekdayOf(date) as 0 | 1 | 2 | 3 | 4 | 5 | 6}`;
}

/** 时刻在 tz 的 HH:MM */
export const timeOf = hhmm;

/** 日程的结束时刻（“到 16:30”）；全天、没时长为 null */
export function eventEnd(r: Reminder, tz: Tz): number | null {
  const date = str(r.row['date']);
  const time = str(r.row['time']);
  const dur = typeof r.row['duration_min'] === 'number' ? r.row['duration_min'] : 0;
  if (date === null || time === null || dur <= 0) return null;
  return startAtOf({ date, time, tz: str(r.row['tz']) }, tz) + dur * 60_000;
}
