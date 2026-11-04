// 月历、周视图的日期导航（架构 5.12 第 3 点、R-99、R-101；第 9 节“日历路由”；TC-B2-13）
// 周起始日、一周的 7 天、上一月 / 下一月、上一周 / 下一周、路由参数的解析和规整、年月选择器在周视图里跳到哪一周、
// “今天”按钮该不该变灰。全是纯日期运算（只用 shared/core/date 的 Date.UTC 运算，不碰本地时区）；
// “今天”由调用方用 todayOf(clock.now(), tz) 算好传进来。hash 本身的拆分归 app/router.ts，这里只管参数那一段。
import { addDays, fmtDateStr, parseDate, weekdayOf, type DateStr } from '../../core/date.ts';
import type { UiLocale } from '../../i18n/pick-locale.ts';

/** 一周从星期几开始：0 = 周日 … 6 = 周六（和 weekdayOf 一致） */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 年月；m 是 1–12 */
export interface YearMonth {
  readonly y: number;
  readonly m: number;
}

/** 路由和年月选择器接受的年份范围（和阴历数据 1900–2100 一致，架构 5.4）；超出的当非法 */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

/** 没设 cal.week_start 时按界面语言取的默认值：中文周一起始，韩文周日起始（两地日历的常见摆法；待负责人确认） */
function defaultWeekStart(locale: UiLocale): WeekStart {
  // check_backend F7：方括号里的键要追得到字面量，查表改用 switch
  switch (locale) {
    case 'zh-CN':
      return 1;
    case 'ko-KR':
      return 0;
  }
}

// 只认周日（0）、周一（1）：界面上只有这两个选项；周二到周五起始时标题按“第一天 + 3 天”算月份，会算出 1899-12 或 2101-01（代码审查 11-04）
function isWeekStart(v: unknown): v is WeekStart {
  return v === 0 || v === 1;
}

/** 设置 cal.week_start 的值是 0 或 1 就用它，没设、不认识（含 2–6）时按界面语言取默认 */
export function resolveWeekStart(setting: unknown, locale: UiLocale): WeekStart {
  return isWeekStart(setting) ? setting : defaultWeekStart(locale);
}

/** date 所在那一周的第一天（按周起始日规整） */
export function startOfWeek(date: DateStr, weekStart: WeekStart): DateStr {
  return addDays(date, -((weekdayOf(date) - weekStart + 7) % 7));
}

/** 从 start 起连续 7 天 */
export function weekDates(start: DateStr): DateStr[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 年月不合法（月份不在 1–12、不是整数）时抛 bad_month；buildMonth、monthGridDates 也用它 */
export function checkYm(ym: YearMonth): void {
  if (!Number.isInteger(ym.y) || !Number.isInteger(ym.m) || ym.m < 1 || ym.m > 12) {
    throw new Error(`bad_month:${ym.y}-${ym.m}`);
  }
}

/** 年月加减 n 个月（跨年） */
export function shiftMonth(ym: YearMonth, n: number): YearMonth {
  checkYm(ym);
  const idx = ym.y * 12 + (ym.m - 1) + n;
  return { y: Math.floor(idx / 12), m: (((idx % 12) + 12) % 12) + 1 };
}

/** 周第一天加减 n 周（跨月、跨年） */
export function shiftWeek(start: DateStr, n: number): DateStr {
  return addDays(start, 7 * n);
}

/** 某月 1 日 */
export function firstOfMonth(ym: YearMonth): DateStr {
  checkYm(ym);
  return fmtDateStr(ym.y, ym.m, 1);
}

/** 日期所在的年月 */
export function monthOf(date: DateStr): YearMonth {
  const { y, m } = parseDate(date);
  return { y, m };
}

/** 路由里的月份写法 '2026-10' */
export function monthKey(ym: YearMonth): string {
  return firstOfMonth(ym).slice(0, 7);
}

function inYearRange(y: number): boolean {
  return y >= MIN_YEAR && y <= MAX_YEAR;
}

/** 解析 '2026-10'；格式不对、月份不存在、年份超出范围时返回 null */
export function parseMonthKey(s: string): YearMonth | null {
  const mt = /^(\d{4})-(\d{2})$/.exec(s);
  if (!mt) return null;
  const y = Number(mt[1]);
  const m = Number(mt[2]);
  return inYearRange(y) && m >= 1 && m <= 12 ? { y, m } : null;
}

/**
 * `#/cal/month/<参数>` 的参数 → 要显示的年月。
 * 不带参数（undefined、空串）表示本月；非法参数也回到本月（5.12：非法日期回到本月 / 本周）。
 */
export function resolveMonthParam(param: string | undefined, today: DateStr): YearMonth {
  return (param ? parseMonthKey(param) : null) ?? monthOf(today);
}

/**
 * 从 start 起的这一周（7 天）有没有一天在 1900–2100 里（代码审查 FA-3 L2）。
 * 周视图的年份范围按“整周有没有沾边”判断：周日起始时 1900 年第一周从 1899-12-31 开始，
 * 2100 年最后一周可能跨进 2101 年，这两周都要到得了。上一周 / 下一周翻不翻也用它判断。
 */
export function weekInRange(start: DateStr): boolean {
  return inYearRange(parseDate(start).y) || inYearRange(parseDate(addDays(start, 6)).y);
}

/**
 * `#/cal/week/<参数>` 的参数 → 这一周的第一天（按 cal.week_start 规整）；
 * 不带参数、格式不对、日期不存在、整周都在 1900–2100 以外时返回 null。
 * 参数合法时，地址里的那一天就是“锚点”：周起始变了（如新设备设置晚到，代码审查 FA-3 L4）要从锚点重新规整，
 * 所以调用方只在返回 null 时 replace 地址，合法但不是那周第一天的参数保持原样、只在内部换算。
 */
export function parseWeekParam(param: string | undefined, weekStart: WeekStart): DateStr | null {
  if (!param || !/^\d{4}-\d{2}-\d{2}$/.test(param)) return null;
  let y: number;
  try {
    y = parseDate(param).y;
  } catch {
    return null; // 日期不存在（如 2-30）
  }
  // 离范围很远的年份（如 9999-12-31）先挡掉：再往后算一周会到 10000 年，parseDate 认不出会抛异常（代码审查 11-04）
  if (y < MIN_YEAR - 1 || y > MAX_YEAR + 1) return null;
  const start = startOfWeek(param, weekStart);
  return weekInRange(start) ? start : null;
}

/**
 * `#/cal/week/<参数>` 的参数 → 这一周的第一天（按 cal.week_start 规整）。
 * 参数是任意一天都规整到它所在那周的第一天；不带参数、非法日期、整周超出年份范围时回到本周。
 * 要不要改地址看 parseWeekParam：只有非法（返回 null）时才 replace，见那里的说明。
 */
export function resolveWeekParam(param: string | undefined, today: DateStr, weekStart: WeekStart): DateStr {
  return parseWeekParam(param, weekStart) ?? startOfWeek(today, weekStart);
}

/**
 * 周视图的年月选择器选了某年某月：跳到该月 1 日所在的那一周，按周起始日规整成那周第一天（R-101）。
 * 例：2026-11 周一起始 → 2026-10-26；周日起始 → 2026-11-01。
 */
export function weekOfPickedMonth(ym: YearMonth, weekStart: WeekStart): DateStr {
  return startOfWeek(firstOfMonth(ym), weekStart);
}

/** 月视图正显示本月吗（“今天”按钮在本月时变灰、不可点） */
export function isThisMonth(ym: YearMonth, today: DateStr): boolean {
  const t = monthOf(today);
  return t.y === ym.y && t.m === ym.m;
}

/** 周视图正显示本周吗（weekStartDate 是这一周的第一天） */
export function isThisWeek(weekStartDate: DateStr, today: DateStr, weekStart: WeekStart): boolean {
  return startOfWeek(today, weekStart) === weekStartDate;
}
