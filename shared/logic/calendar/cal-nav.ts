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

function isWeekStart(v: unknown): v is WeekStart {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6;
}

/** 设置 cal.week_start 的值（0–6 的整数）有效就用它，没设或不认识时按界面语言取默认 */
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
 * `#/cal/week/<参数>` 的参数 → 这一周的第一天（按 cal.week_start 规整）。
 * 参数是任意一天都规整到它所在那周的第一天；不带参数、非法日期、年份超出范围时回到本周。
 * 规整后和参数不一样时，调用方用 replace 改地址（不新增历史记录）。
 */
export function resolveWeekParam(param: string | undefined, today: DateStr, weekStart: WeekStart): DateStr {
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) {
    try {
      const { y } = parseDate(param);
      if (inYearRange(y)) return startOfWeek(param, weekStart);
    } catch {
      // 日期不存在（如 2-30），按非法处理
    }
  }
  return startOfWeek(today, weekStart);
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
