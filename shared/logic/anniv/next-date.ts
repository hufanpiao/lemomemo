// 纪念日的日期和提醒推算（B5 S12，架构 5.4；R-33、R-94、R-403；TC-B5-19、21、22、23）：前后端共用一份
// • 服务器：push-dispatch 的 annivNext（第 0 步重算、第 6 步推过以后算下一次）、anniv-roll（每天滚动、归档）；
//   界面：纪念日列表和编辑页、日历的菱形、今天页的纪念日一行。界面一侧要整个按需加载本文件（它静态引 lunar.ts 的农历表，2.6 不进首屏）。
// • 纯函数：只做纯日期运算；“现在”和时区一律由调用方传（A15）。
// • 下一次（nextOn）：
//   阳历——今年的月日，已经过了取明年；2-29 在平年取 2-28。
//   阴历——对农历年 Y−1、Y、Y+1 各算一遍（Y = today 的公历年），取不早于 today 的最早那个（腊月生日落在下一个公历年的 1、2 月）；
//   闰月当年没有 → 用同号平月（R-403，不给选项）；三十日不存在 → 用廿九。只按中国农历（D1：韩国阴历先不做，'kr' 的行算不出、按只读行处理）。
// • 倒数日（countdown）：有年份就是那一天；没年份取“从创建那天起第一个该月日”（R-403，创建当天就是这个月日的取当天）。
//   过了目标日：after_due = yearly 按年滚到下一次；archive 留在目标日、算“已过去”（archived_at 由 anniv-roll 写，界面直接按这里算）。
// • 提醒（R-94）：offsets = 这一条的 remind_offsets ?? 设置 anniv.default_offsets ?? {7,1}；time = remind_time ?? anniv.default_time ?? 09:00；
//   remind_at = 下一个还没到的 (next − offset 天) 的 time，按 current_tz 换算（浮动时刻）。这一次的都过了，就取再下一次的（每年的那几种）。
// • 周岁（第几年）：有年份才算；阳历按下一次所在的公历年，阴历按下一次所在的农历年。
import { addDays, diffDays, fmtDateStr, msAt, parseDate, parseHm, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import { toSolar } from './lunar.ts';

export type AnnivKind = 'birthday' | 'anniversary' | 'countdown';
export type AnnivCalendar = 'solar' | 'lunar';
export type AfterDue = 'archive' | 'yearly';

/** 推算要用的列（anniversaries 的同名列；created_at 只有没年份的倒数日用） */
export interface AnnivRec {
  readonly kind: AnnivKind;
  readonly calendar: AnnivCalendar;
  /** 只认 'cn'；别的值（'kr'）一律算不出（D1） */
  readonly lunar_variant: string;
  readonly month: number;
  readonly day: number;
  readonly is_leap: boolean;
  readonly year: number | null;
  readonly after_due: AfterDue;
  readonly remind_offsets: readonly number[] | null;
  readonly remind_time: string | null;
  /** 建这一条的时刻（epoch ms） */
  readonly created_at: number | null;
}

/** 出厂默认（anniv.default_offsets、anniv.default_time 没设时） */
export const DEFAULT_OFFSETS: readonly number[] = [7, 1];
export const DEFAULT_TIME = '09:00';
/** 编辑页“提前几天”的快捷选项（0 = 当天）；自定义 0～60；最多选 4 个（表的 check） */
export const OFFSET_CHOICES: readonly number[] = [0, 1, 3, 7, 14, 30];
export const OFFSET_MAX = 60;
export const OFFSETS_MAX = 4;
/** 表的 year 范围（0005_anniv.sql） */
export const YEAR_MIN = 1900;
export const YEAR_MAX = 2100;

const SOLAR_MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** 一次纪念日：哪一天（公历），属于哪一年（阳历是公历年，阴历是农历年；算周岁用） */
export interface Occurrence {
  readonly date: DateStr;
  readonly year: number;
}

/**
 * 月日（含年份）合不合格（R-403：2-30、4-31 这类保存时拒）。
 * 阳历：月 1～12、日不超过这个月最多的天数（2 月 29）；有年份时这一天在那一年要存在（平年没有 2-29）。
 * 阴历：月 1～12、日 1～30；有年份时那一年要真有这一天（闰月、三十），按中国农历的表核对。
 */
export function validDate(r: Pick<AnnivRec, 'calendar' | 'month' | 'day' | 'is_leap' | 'year'>): boolean {
  if (!intIn(r.month, 1, 12) || !intIn(r.day, 1, 31)) return false;
  if (r.year !== null && !intIn(r.year, YEAR_MIN, YEAR_MAX)) return false;
  if (r.calendar === 'solar') {
    if (r.is_leap || r.day > (SOLAR_MAX_DAY[r.month - 1] ?? 0)) return false;
    return r.year === null || r.month !== 2 || r.day !== 29 || isLeapYear(r.year);
  }
  if (r.day > 30) return false;
  return r.year === null || toSolar(r.year, r.month, r.day, r.is_leap, 'cn') !== null;
}

/** 某一年（阳历：公历年；阴历：农历年）的这一天；那一年算不出（超出农历表、版本不认识）返回 null */
export function occurrenceIn(r: Pick<AnnivRec, 'calendar' | 'lunar_variant' | 'month' | 'day' | 'is_leap'>, y: number): Occurrence | null {
  if (r.calendar === 'solar') {
    const d = r.month === 2 && r.day === 29 && !isLeapYear(y) ? 28 : r.day;
    if (y < 1 || y > 9999) return null;
    return { date: fmtDateStr(y, r.month, d), year: y };
  }
  if (r.lunar_variant !== 'cn') return null;
  // 先按原样；闰月当年没有用同号平月；三十没有用廿九（两条可以叠加）
  const tries: [number, boolean][] = [[r.day, r.is_leap]];
  if (r.is_leap) tries.push([r.day, false]);
  if (r.day === 30) tries.push([29, r.is_leap], [29, false]);
  for (const [d, leap] of tries) {
    const s = toSolar(y, r.month, d, leap, 'cn');
    if (s !== null) return { date: s, year: y };
  }
  return null;
}

/** 不早于 from 的最早一次（每年都有的那种）；算不出返回 null */
export function onOrAfter(r: AnnivRec, from: DateStr): Occurrence | null {
  const y = parseDate(from).y;
  const years = r.calendar === 'solar' ? [y, y + 1] : [y - 1, y, y + 1];
  let best: Occurrence | null = null;
  for (const yy of years) {
    const o = occurrenceIn(r, yy);
    if (o && o.date >= from && (best === null || o.date < best.date)) best = o;
  }
  return best;
}

/** 倒数日的目标日：有年份就是那一天；没年份取创建那天起第一个该月日（R-403）。createdDay 为空时按 today 算 */
export function countdownTarget(r: AnnivRec, createdDay: DateStr): Occurrence | null {
  return r.year !== null ? occurrenceIn(r, r.year) : onOrAfter(r, createdDay);
}

/** 列表、编辑页、提醒用的状态 */
export interface AnnivState {
  /** 下一次（已过去的倒数日是它的目标日） */
  readonly next: Occurrence;
  /** 已过去的倒数日（after_due = archive、目标日早于今天） */
  readonly past: boolean;
  /** 还有几天（0 = 今天；已过去的倒数日是负数） */
  readonly days: number;
  /** 满几周岁（生日）、第几年（纪念日）；没年份、倒数日为 null */
  readonly age: number | null;
}

/** 这一条在 today 这天的状态；算不出（数据坏了、农历超出范围、韩国阴历）返回 null */
export function annivState(r: AnnivRec, today: DateStr, createdDay: DateStr = today): AnnivState | null {
  let next: Occurrence | null;
  let past = false;
  if (r.kind === 'countdown') {
    const target = countdownTarget(r, createdDay);
    if (target === null) return null;
    if (target.date >= today) next = target;
    else if (r.after_due === 'yearly') next = onOrAfter(r, today);
    else {
      next = target;
      past = true;
    }
  } else next = onOrAfter(r, today);
  if (next === null) return null;
  const age = r.kind !== 'countdown' && r.year !== null ? next.year - r.year : null;
  return { next, past, days: diffDays(today, next.date), age };
}

/** 从 from 起（含）最多 n 次的公历日期（电脑详情的“接下来 3 次”）；已过去的倒数日只有它自己 */
export function upcoming(r: AnnivRec, from: DateStr, n: number, createdDay: DateStr = from): readonly DateStr[] {
  const out: DateStr[] = [];
  const st = annivState(r, from, createdDay);
  if (st === null) return out;
  out.push(st.next.date);
  if (st.past || (r.kind === 'countdown' && r.after_due === 'archive')) return out;
  while (out.length < n) {
    const o = onOrAfter(r, addDays(out[out.length - 1] as DateStr, 1));
    if (o === null) break;
    out.push(o.date);
  }
  return out;
}

/** from～to（含两端）之间落在哪几天（月历的菱形）。倒数日：目标日；每年重复的还有目标日以后的每一次 */
export function datesBetween(r: AnnivRec, from: DateStr, to: DateStr, createdDay: DateStr = from): readonly DateStr[] {
  const out: DateStr[] = [];
  let start = from;
  if (r.kind === 'countdown') {
    const target = countdownTarget(r, createdDay);
    if (target === null) return out;
    if (r.after_due === 'archive') return target.date >= from && target.date <= to ? [target.date] : out;
    if (target.date > start) start = target.date;
  }
  for (let o = onOrAfter(r, start); o !== null && o.date <= to; o = onOrAfter(r, addDays(o.date, 1))) out.push(o.date);
  return out;
}

/** 提醒设置 → 实际用的提前天数（去重、从大到小）；设置里的值不合格按出厂 */
export function offsetsOf(r: Pick<AnnivRec, 'remind_offsets'>, settings: Readonly<Record<string, unknown>>): readonly number[] {
  const ok = (v: unknown): v is readonly number[] =>
    Array.isArray(v) && v.length >= 1 && v.length <= OFFSETS_MAX && v.every((x) => intIn(x, 0, OFFSET_MAX));
  const raw = ok(r.remind_offsets) ? r.remind_offsets : ok(settings['anniv.default_offsets']) ? settings['anniv.default_offsets'] : DEFAULT_OFFSETS;
  return [...new Set(raw)].sort((a, b) => b - a);
}

/** 提醒的时刻（HH:MM）；设置里的值不合格按出厂 */
export function remindTimeOf(r: Pick<AnnivRec, 'remind_time'>, settings: Readonly<Record<string, unknown>>): string {
  const d = settings['anniv.default_time'];
  return r.remind_time !== null && HM_RE.test(r.remind_time) ? r.remind_time : typeof d === 'string' && HM_RE.test(d) ? d : DEFAULT_TIME;
}

/** 某一次（date）的几个提醒时刻里不早于 now 的最早一个 */
function firstAfter(date: DateStr, offsets: readonly number[], min: number, tz: Tz, now: number): number | null {
  let best: number | null = null;
  for (const o of offsets) {
    const at = msAt(addDays(date, -o), min, tz);
    if (at >= now && (best === null || at < best)) best = at;
  }
  return best;
}

/** 系统列 next_date、remind_at 的新值（push-dispatch、anniv-roll 写；界面显示“下一次提醒”也用它） */
export interface AnnivNext {
  readonly next_date: DateStr | null;
  readonly remind_at: number | null;
}

/** 按 current_tz（tz）、现在（now）和这个人的设置算下一次；算不出 next_date 为 null（不提醒） */
export function annivNextAt(r: AnnivRec, tz: Tz, now: number, settings: Readonly<Record<string, unknown>>): AnnivNext {
  const today = todayOf(now, tz);
  const createdDay = r.created_at !== null ? todayOf(r.created_at, tz) : today;
  const st = annivState(r, today, createdDay);
  if (st === null) return { next_date: null, remind_at: null };
  if (st.past) return { next_date: st.next.date, remind_at: null };
  const offsets = offsetsOf(r, settings);
  const min = parseHm(remindTimeOf(r, settings));
  let at = firstAfter(st.next.date, offsets, min, tz, now);
  // 这一次的提醒都过了（当天 9:00 以后才建的、或刚推完最后一个）：每年都有的取再下一次的
  if (at === null && !(r.kind === 'countdown' && r.after_due === 'archive')) {
    const o = onOrAfter(r, addDays(st.next.date, 1));
    if (o !== null) at = firstAfter(o.date, offsets, min, tz, now);
  }
  return { next_date: st.next.date, remind_at: at };
}

/**
 * 库里读出来的一行（列都可能缺、类型不对）→ AnnivRec；不合格（枚举认不出、月日越界）返回 null。
 * 前端的只读行判断、服务器的重算都经这里，认法只写一份
 */
export function annivRecOf(row: Readonly<Record<string, unknown>>): AnnivRec | null {
  const kind = row['kind'];
  const calendar = row['calendar'];
  const afterDue = row['after_due'] ?? 'archive';
  if (kind !== 'birthday' && kind !== 'anniversary' && kind !== 'countdown') return null;
  if (calendar !== 'solar' && calendar !== 'lunar') return null;
  if (afterDue !== 'archive' && afterDue !== 'yearly') return null;
  const year = row['year'] ?? null;
  const offs = row['remind_offsets'] ?? null;
  const time = row['remind_time'] ?? null;
  const created = row['created_at'] ?? null;
  const rec: AnnivRec = {
    kind, calendar, after_due: afterDue,
    lunar_variant: typeof row['lunar_variant'] === 'string' ? row['lunar_variant'] : 'cn',
    month: row['month'] as number, day: row['day'] as number, is_leap: row['is_leap'] === true,
    year: year === null ? null : (year as number),
    remind_offsets: Array.isArray(offs) ? (offs as number[]) : null,
    remind_time: typeof time === 'string' ? time : null,
    created_at: typeof created === 'number' && Number.isFinite(created) ? created : null,
  };
  return validDate(rec) ? rec : null;
}

/** push-dispatch 的 annivNext 接口（round-types.ts 的 AnnivNext）：行不合格时抛 bad_anniv，第 0 步记 failed */
export function annivNextOf(row: Readonly<Record<string, unknown>>, ctx: { tz: Tz; now: number; settings: Readonly<Record<string, unknown>> }): AnnivNext {
  const r = annivRecOf(row);
  if (r === null) throw new Error('bad_anniv');
  return annivNextAt(r, ctx.tz, ctx.now, ctx.settings);
}

/** 建这一条那天（没年份的倒数日从这天起算，R-403）：created_at 按 tz 取日期；没有时按 fallback */
export function createdDayOf(row: Readonly<Record<string, unknown>>, tz: Tz, fallback: DateStr): DateStr {
  const c = row['created_at'];
  return typeof c === 'number' && Number.isFinite(c) ? todayOf(c, tz) : fallback;
}

/**
 * 一批行在 from～to（含）里有纪念日的日子（日历月格的菱形）：已删、撤销、只读（annivRecOf 回 null）、韩国阴历的跳过；
 * 单条算出错（农历超出表范围等）只跳过那一条，不让整张月历算不下去
 */
export function annivDatesIn(rows: readonly Readonly<Record<string, unknown>>[], from: DateStr, to: DateStr, tz: Tz): ReadonlySet<DateStr> {
  const out = new Set<DateStr>();
  for (const row of rows) {
    if ((row['deleted_at'] ?? null) !== null || row['undone'] === true) continue;
    const r = annivRecOf(row);
    if (r === null || r.lunar_variant !== 'cn') continue;
    try {
      for (const d of datesBetween(r, from, to, createdDayOf(row, tz, from))) out.add(d);
    } catch {
      // 跳过这一条
    }
  }
  return out;
}

/**
 * 界面一侧“这一次”的提醒时刻（B5 S15：提醒横幅、错过的提醒、未来 7 天、整页提醒）：
 * 从 max(now − lookbackMs, 建这一条的时刻, 上次“知道了”的 notified_for + 1) 起，第一个提醒时刻。
 * • 只有按了“知道了”才往后走一次：同一次提醒在处理前时刻不变（tag 稳定，和服务器推这一次时的 due 同一个值）；
 *   过了点没处理的留着，进“错过的提醒”。服务器推完会把 remind_at 列挪到下一次，界面不看那一列
 * • 同时给出这次提醒对应的那一次纪念日（date：提醒那天起的下一次；提醒横幅写“7 天后”、生成待办定截止日用）
 * • 行不合格、韩国阴历（D1）、已过去的倒数日、算出错：返回 null（不提醒）
 */
export function annivRemindFrom(
  row: Readonly<Record<string, unknown>>,
  tz: Tz,
  now: number,
  settings: Readonly<Record<string, unknown>>,
  lookbackMs: number,
): { readonly at: number; readonly date: DateStr } | null {
  const r = annivRecOf(row);
  if (r === null || r.lunar_variant !== 'cn') return null;
  const acked = row['notified_for'];
  let from = now - lookbackMs;
  if (r.created_at !== null) from = Math.max(from, r.created_at);
  if (typeof acked === 'number' && Number.isFinite(acked)) from = Math.max(from, acked + 1);
  try {
    const at = annivNextAt(r, tz, from, settings).remind_at;
    if (at === null) return null;
    const day = todayOf(at, tz);
    const st = annivState(r, day, r.created_at !== null ? todayOf(r.created_at, tz) : day);
    return st === null ? null : { at, date: st.next.date };
  } catch {
    return null;
  }
}
