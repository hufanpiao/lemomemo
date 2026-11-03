// 月历的 6×7 格子（架构 5.12 第 2 点、R-98、R-100、R-104；第 9 节“month-grid”；TC-B2-08）
// buildMonth(ym, items, opts) 返回 42 个格子：从“本月 1 日所在那周的第一天”起连排 6 周，前后跨月的补位格 inMonth = false。
// • 一件事一个 mark（按事件，不按项目）：short 取 displayShort，colorIndex 取项目色（没有项目为 0），kind 标出是哪类；
// • 算进去的：当天的日程（固定时刻按设备时区换算后的日期）、截止日在当天且未完成的待办；删掉的不算（和 dayEntries 同一套）；
// • 纪念日、倒数日不占标签，只看 opts.annivDates 标 anniv；
// • 每格最多 opts.maxMarks 个（手机 2、电脑 4，由界面按窗口档位给），多出来的件数记进 more（显示“+N”）；
// • 读屏 a11y 按规整后的项目名（normalizeProject，和分色同一套）汇总当天全部件数（含没显示出来的），
//   顺序按当天排序后各项目第一次出现的先后。
// 纯函数；“按月缓存”由界面一侧按 (年月, 数据版本, opts) 记住结果（useMemo），这里不放模块级缓存。
import { addDays, parseDate, weekdayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import type { ProjectColor } from '../project-color.ts';
import { assertTz, collectEntries, type CalItems, type DayEntry } from './cal-items.ts';
import { checkYm, firstOfMonth, startOfWeek, type WeekStart, type YearMonth } from './cal-nav.ts';
import type { HolidayMark } from './holidays.ts';

/** 格子数：6 周 × 7 天 */
export const MONTH_CELLS = 42;

/** 格子里的一个标签 */
export interface MonthMark {
  readonly itemId: string;
  readonly kind: DayEntry['kind'];
  readonly colorIndex: ProjectColor;
  readonly short: string;
}

/** 读屏用：某个项目当天几件（project 是规整后的项目名，空串表示没有项目） */
export interface ProjectCount {
  readonly project: string;
  readonly count: number;
}

export interface MonthCell {
  readonly date: DateStr;
  /** 星期几：0 = 周日 … 6 = 周六（界面标周末色用） */
  readonly weekday: number;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly holidays: readonly HolidayMark[];
  readonly solarTerm?: string;
  readonly lunar?: string;
  readonly marks: readonly MonthMark[];
  /** 没显示出来的件数（“+N”） */
  readonly more: number;
  readonly anniv: boolean;
  readonly a11y: readonly ProjectCount[];
}

/** 月历的输入（和 dayEntries 同一个形状） */
export type MonthItems = CalItems;

export interface MonthOpts {
  /** 设备当前时区：固定时刻的日程按它换算日期；无效时抛 bad_tz */
  readonly tz: Tz;
  /** 设备时区的今天（todayOf(clock.now(), tz)） */
  readonly today: DateStr;
  readonly weekStart: WeekStart;
  /** 每格最多几个标签：手机 2、电脑 4 */
  readonly maxMarks: number;
  /** holidayMarks() 的结果；不传就没有节假日 */
  readonly holidays?: ReadonlyMap<DateStr, readonly HolidayMark[]>;
  /** 有纪念日或倒数日的日期（纪念日的日期推算归 anniv，B5） */
  readonly annivDates?: ReadonlySet<DateStr>;
  /** 农历、节气的显示文字（数据归后端 D5、农历在单独的 chunk；没有时可不传） */
  readonly dayInfo?: (date: DateStr) => { readonly lunar?: string; readonly solarTerm?: string };
}

function summarize(entries: readonly DayEntry[]): ProjectCount[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.project, (counts.get(e.project) ?? 0) + 1);
  return Array.from(counts, ([project, count]) => ({ project, count }));
}

/** 6×7 的格子日期（从本月 1 日所在那周的第一天起连排 42 天）；月份不合法时抛 bad_month */
export function monthGridDates(ym: YearMonth, weekStart: WeekStart): DateStr[] {
  checkYm(ym);
  const start = startOfWeek(firstOfMonth(ym), weekStart);
  return Array.from({ length: MONTH_CELLS }, (_, i) => addDays(start, i));
}

/** 某年某月的 6×7 格子 */
export function buildMonth(ym: YearMonth, items: MonthItems, opts: MonthOpts): MonthCell[] {
  if (!Number.isInteger(opts.maxMarks) || opts.maxMarks < 0) throw new Error(`bad_max_marks:${opts.maxMarks}`);
  assertTz(opts.tz);
  parseDate(opts.today);
  const dates = monthGridDates(ym, opts.weekStart);
  const first = dates[0] ?? firstOfMonth(ym);
  const last = dates[dates.length - 1] ?? first;
  const buckets = collectEntries(items, first, last, opts.tz);
  return dates.map((date) => {
    const entries = buckets.get(date) ?? [];
    const shown = entries.slice(0, opts.maxMarks);
    const info = opts.dayInfo?.(date);
    return {
      date,
      weekday: weekdayOf(date),
      inMonth: parseDate(date).m === ym.m,
      isToday: date === opts.today,
      holidays: opts.holidays?.get(date) ?? [],
      ...(info?.solarTerm === undefined ? {} : { solarTerm: info.solarTerm }),
      ...(info?.lunar === undefined ? {} : { lunar: info.lunar }),
      marks: shown.map((e) => ({ itemId: e.itemId, kind: e.kind, colorIndex: e.colorIndex, short: e.short })),
      more: entries.length - shown.length,
      anniv: opts.annivDates?.has(date) ?? false,
      a11y: summarize(entries),
    };
  });
}

// 架构审 Q3 ①：buildMonth、buildWeek 都从 month-grid.ts 取。buildWeek 的实现放在 week-view.ts（合在一个文件会超过 W1 的 300 行），这里转出
export { buildWeek } from './week-view.ts';
export type { PhoneDay, DeskDay, PhoneBlock, DeskBlock, PhoneGroup, AllDay, PhoneWeekOpts, DeskWeekOpts, WeekItems, Cont } from './week-view.ts';
// 单日列表也从这里取（前端 A 会审 ③）
export { dayEntries, type DayEntry } from './cal-items.ts';
