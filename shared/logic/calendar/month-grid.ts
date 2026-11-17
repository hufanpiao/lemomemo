// 月历的 6×7 格子（架构 5.12 第 2 点、R-98、R-100、R-104；第 9 节“month-grid”；TC-B2-08）
// buildMonth(ym, items, opts) 返回 42 个格子：从“本月 1 日所在那周的第一天”起连排 6 周，前后跨月的补位格 inMonth = false。
// • 一件事一个 mark（按事件，不按项目）：short 取 displayShort，colorIndex 取项目色（没有项目为 0），kind 标出是哪类；
// • 算进去的：当天的日程（固定时刻按设备时区换算后的日期）、截止日在当天且未完成的待办；删掉的不算（和 dayEntries 同一套）；
// • 纪念日、倒数日不占标签，只看 opts.annivDates 标 anniv；
// • 每格最多 opts.maxMarks 排（手机 2、电脑 4，由界面按窗口档位给），多出来的件数记进 more（显示“+N”）；
// • 跨天的日程（R-444；R-445 负责人选“一整条色块”）按周排：同一周里它占的几格画成一整条，排在同一排（slot）；
//   跨到下一周的另起一段，每段开头再写一次名字；bar.cont 标出被切开的一边（和周视图时刻块同一个 Cont，界面那一端画直角、不画左侧深色竖线）。
//   一周里先给跨天的排位（开始得早的、跨得长的在上面），再把当天的单日事项按顺序填进空着的排；排不下的都记进 more；
// • 读屏 a11y 按规整后的项目名（normalizeProject，和分色同一套）汇总当天全部件数（含没显示出来的），
//   顺序按当天排序后各项目第一次出现的先后。
// 纯函数；“按月缓存”由界面一侧按 (年月, 数据版本, opts) 记住结果（useMemo），这里不放模块级缓存。
import { addDays, parseDate, weekdayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import type { ProjectColor } from '../project-color.ts';
import { assertTz, collectEntries, compareEntries, type CalItems, type DayEntry } from './cal-items.ts';
import { checkYm, firstOfMonth, startOfWeek, type WeekStart, type YearMonth } from './cal-nav.ts';
import type { Cont } from './event-span.ts';
import type { HolidayMark } from './holidays.ts';

/** 格子数：6 周 × 7 天 */
export const MONTH_CELLS = 42;

/** 跨天日程在这一周里的一段（R-445）：从 head 那一格起往右画 cols 格 */
export interface MonthBar {
  /** 这一格是不是这一段的头（画色块、写名字的那一格）；不是头的格子只空出这一排 */
  readonly head: boolean;
  /** 这一段占几格（同一周里，1～7） */
  readonly cols: number;
  /** 这一段被切开的一边（和周视图时刻块同一个 Cont：'start' 头从上一周接过来、'end' 尾接到下一周、'both' 两头都接着）；整段都在这一周里的没有 */
  readonly cont?: Cont;
}

/** 格子里的一个标签 */
export interface MonthMark {
  readonly itemId: string;
  readonly kind: DayEntry['kind'];
  readonly colorIndex: ProjectColor;
  readonly short: string;
  /** 第几排（0 起，< maxMarks）；同一条跨天色块在这一周里每一格都是同一排 */
  readonly slot: number;
  /** 跨天的日程才有 */
  readonly bar?: MonthBar;
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
  /** 这一格占着的排，按 slot 排好（跨天色块不是头的那几格也在里面，bar.head 为 false） */
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

/** 一个日子里的事项 → 标签（slot、bar 另给） */
function markOf(e: DayEntry, slot: number, bar?: MonthBar): MonthMark {
  return { itemId: e.itemId, kind: e.kind, colorIndex: e.colorIndex, short: e.short, slot, ...(bar ? { bar } : {}) };
}

/** 一段的头接着前面、尾接着后面 → 被切开的一边 */
function segCont(before: boolean, after: boolean): Cont | undefined {
  if (before) return after ? 'both' : 'start';
  return after ? 'end' : undefined;
}

/** 一周 7 天的标签和 more：先排跨天色块（开始早的、跨得长的在上），再把单日的填进空着的排（R-445） */
// 每一列一份状态（标签、“+N”、已占的排），按列号一律用 .at() 取：shared 会复制给服务器函数，check_backend F7 不放行
// forEach 下标、算出来的列号放进方括号（CI deploy-preview a8f59046 构建被拦）；三份平行数组合成一份，也少了按下标对齐
type WeekCol = { marks: MonthMark[]; more: number; used: Set<number> };
function layoutWeek(week: readonly DateStr[], lists: readonly (readonly DayEntry[])[], maxMarks: number): WeekCol[] {
  const cs: WeekCol[] = week.map(() => ({ marks: [], more: 0, used: new Set<number>() }));
  const bars = new Map<string, { e: DayEntry; from: number; to: number }>();
  lists.forEach((list, col) => {
    for (const e of list) {
      if (e.span === undefined) continue;
      const b = bars.get(e.itemId);
      if (b) b.to = col;
      else bars.set(e.itemId, { e, from: col, to: col });
    }
  });
  const order = [...bars.values()].sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || compareEntries(a.e, b.e));
  for (const { e, from, to } of order) {
    const cols = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    let slot = 0;
    while (slot < maxMarks && cols.some((c) => cs.at(c)?.used.has(slot))) slot++;
    const span = e.span;
    const cont = span === undefined ? undefined : segCont(span.date < (week.at(from) ?? span.date), span.lastDate > (week.at(to) ?? span.lastDate));
    for (const c of cols) {
      const col = cs.at(c);
      if (!col) continue;
      if (slot >= maxMarks || span === undefined) {
        col.more += 1;
        continue;
      }
      col.used.add(slot);
      col.marks.push(markOf(e, slot, { head: c === from, cols: to - from + 1, ...(cont ? { cont } : {}) }));
    }
  }
  lists.forEach((list, i) => {
    const col = cs.at(i);
    if (!col) return;
    for (const e of list) {
      if (e.span !== undefined) continue;
      let slot = 0;
      while (slot < maxMarks && col.used.has(slot)) slot++;
      if (slot >= maxMarks) {
        col.more += 1;
        continue;
      }
      col.used.add(slot);
      col.marks.push(markOf(e, slot));
    }
    col.marks.sort((a, b) => a.slot - b.slot);
  });
  return cs;
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
  const cells: MonthCell[] = [];
  for (let w = 0; w < dates.length; w += 7) {
    const week = dates.slice(w, w + 7);
    const lists = week.map((d) => buckets.get(d) ?? []);
    const cs = layoutWeek(week, lists, opts.maxMarks);
    week.forEach((date, i) => {
      const col = cs.at(i);
      const info = opts.dayInfo?.(date);
      cells.push({
        date,
        weekday: weekdayOf(date),
        inMonth: parseDate(date).m === ym.m,
        isToday: date === opts.today,
        holidays: opts.holidays?.get(date) ?? [],
        ...(info?.solarTerm === undefined ? {} : { solarTerm: info.solarTerm }),
        ...(info?.lunar === undefined ? {} : { lunar: info.lunar }),
        marks: col?.marks ?? [],
        more: col?.more ?? 0,
        anniv: opts.annivDates?.has(date) ?? false,
        a11y: summarize(lists.at(i) ?? []),
      });
    });
  }
  return cells;
}

// 架构审 Q3 ①：buildMonth、buildWeek 都从 month-grid.ts 取。buildWeek 的实现放在 week-view.ts（合在一个文件会超过 W1 的 300 行），这里转出
export { buildWeek, segmentOn } from './week-view.ts';
export type { PhoneDay, DeskDay, PhoneBlock, DeskBlock, PhoneGroup, AllDay, PhoneWeekOpts, DeskWeekOpts, WeekItems, DayOf } from './week-view.ts';
// 单日列表也从这里取（前端 A 会审 ③）
export { dayEntries, type DayEntry } from './cal-items.ts';
