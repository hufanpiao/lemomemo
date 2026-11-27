// i18n-exempt: 解析词表
// AI 抄出的“说日子、说时刻的字”按本机规则换算（11-25 负责人真机：语音“AI 自动整理的时候日期总是弄错”，“周五变成周日，后天变成明天，周五变成今天”）。
// 做法：提示词让 AI 给每一条原样抄出原话里说日子的字（date_said，如“周五”“后天”“下周一”“11月30号”“금요일”“모레”）和说时刻的字
//   （time_said，如“下午3点”“5点前”“半小时后”“오후 3시”），日子、时刻由这里用本机规则同一套词表（date-words.ts 的 takeDate、
//   time-words.ts 的 takeTime、takeRelative；预处理同 parseSplit 的 prepare）按同一个 now、tz 换算；shared/schema/ai.ts 校验时
//   换算得出来的覆盖 AI 自己算的 date / due、time，换算不出来才用 AI 的。日子不再让模型自己数。
// 认不准的一律交回 null（用 AI 的）：字太长（超过 SAID_MAX 个码点）、带重复说法（“每周一”的最近一次由 AI 按规则算）、
//   里面有两个日子（“周五或者周六”）、认不出（“周末”“过几天”）。
// 时刻：相对时刻（“半小时后”）连日子一起定（过午夜进第二天）；“今晚 12 点”这类跨到次日的，只在日子也是从字里认出来时挪一天
//   （没说日子的由 AI 按提示词规则定，不硬塞日子）。时长、截止与否不在这里改（仍按 AI 的 kind、duration_min）。
// 纯函数，前端和 Edge Functions 共用（经 shared/schema/ai.ts）。
import { addDays, fmtHm, minOfDay, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import { takeDate } from './date-words.ts';
import type { DateBasis } from './past-date.ts';
import { recurHint } from './recur-hint.ts';
import { prepare, type Rest } from './text.ts';
import { takeRelative, takeTime } from './time-words.ts';

/** 抄出的字最多认多长（码点）；再长的多半不是只抄了日子，不认 */
export const SAID_MAX = 40;

export interface SaidWhen {
  /** 从 date_said（或相对时刻）认出的日子；认不出为 null */
  day: { date: DateStr; basis: DateBasis } | null;
  /** 从 time_said 认出的时刻（HH:MM）；认不出为 null */
  time: string | null;
}

const NONE: SaidWhen = { day: null, time: null };

/** 能拿来认的字：去空白，空的、太长的、带重复说法的为 null */
function usable(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  if (t === '' || [...t].length > SAID_MAX || recurHint(t)) return null;
  return t;
}

const rest = (s: string): Rest => ({ text: ` ${prepare(s)} ` });

/** date_said、time_said → 本机规则换算的日子和时刻（见文件头）；now 毫秒、tz 时区，和本机规则、AI 提示词同一份 */
export function saidWhen(dateSaid: string | null | undefined, timeSaid: string | null | undefined, now: number, tz: Tz): SaidWhen {
  const ds = usable(dateSaid);
  const ts = usable(timeSaid);
  if (ds === null && ts === null) return NONE;
  const today = todayOf(now, tz);
  let day: SaidWhen['day'] = null;
  let period = '';
  if (ds !== null) {
    const st = rest(ds);
    const d = takeDate(st, today);
    // 认出了、而且剩下的字里没有第二个日子
    if (d?.ok && takeDate(st, today) === null) {
      day = { date: d.date, basis: d.basis };
      period = d.period;
    }
  }
  if (ts === null) return { day, time: null };
  const st = rest(ts);
  const rel = takeRelative(st);
  if (rel !== null) {
    const at = minOfDay(now, tz) + rel;
    return { day: { date: addDays(today, Math.floor(at / 1440)), basis: 'rel' }, time: fmtHm(at % 1440) };
  }
  const tm = takeTime(st, period);
  if (!tm) return { day, time: null };
  if (tm.nextDay && day) day = { date: addDays(day.date, 1), basis: 'rel' };
  return { day, time: tm.time };
}
