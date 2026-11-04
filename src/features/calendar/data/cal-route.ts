// 月历、周视图的路由（B2 FA-3，架构 5.12）：#/cal/month/<年-月>、#/cal/week/<那周任一天>；#/calendar（底栏）等于本月
// • 解析交给前端 B 的 cal-nav（resolveMonthParam、parseWeekParam）：非法参数回到本月 / 本周；周参数可以是这一周里任意合法的一天，当锚点，合法就不改地址
// • 规整后的参数和地址里的不一样时，canonical 给出该用 replace 换上的参数（不新增历史记录）
// 纯 TS：不碰 React、不碰路由本身（页面经 hooks 调 navigateInPage / replaceInPage：同一页内切换不起 View Transition，架构 5.12）
import { addDays, type DateStr } from '../../../../shared/core/date.ts';
import {
  isThisMonth,
  isThisWeek,
  MAX_YEAR,
  MIN_YEAR,
  monthKey,
  monthOf,
  parseWeekParam,
  resolveMonthParam,
  shiftMonth,
  shiftWeek,
  startOfWeek,
  weekInRange,
  weekOfPickedMonth,
  type WeekStart,
  type YearMonth,
} from '../../../../shared/logic/calendar/cal-nav.ts';

export type CalView = { readonly mode: 'month'; readonly ym: YearMonth } | { readonly mode: 'week'; readonly start: DateStr };

export interface ResolvedView {
  readonly view: CalView;
  /** 地址里的参数要换成这个（规整过、或原来非法）；和地址一致时为 null */
  readonly canonical: readonly string[] | null;
}

/** 视图 → 路由参数（不含路由名 'cal'） */
export function paramsOf(view: CalView): string[] {
  return view.mode === 'month' ? ['month', monthKey(view.ym)] : ['week', view.start];
}

/**
 * 路由参数 → 视图。params 是 #/cal/ 后面的部分；#/calendar（底栏，没有参数）当本月，不改地址。
 * 模式认不出来当月视图
 */
export function resolveView(params: readonly string[], today: DateStr, weekStart: WeekStart): ResolvedView {
  const [mode, arg] = params;
  if (mode === 'week') {
    // L4（前端 B 改 cal-nav 后配合）：周参数是“那一周里的任一天”，合法就不改地址（设置晚到、周起始变了也落在对的那周）；
    // 非法时换成“今天”本身（不是本周第一天），之后周起始再变也还落在本周。
    // 周视图里切换周起始时，锚点那天如果变成新一周的最后一天，画面会往前挪一周，这是预期行为
    const start = parseWeekParam(arg, weekStart);
    if (start !== null) return { view: { mode: 'week', start }, canonical: params.length === 2 ? null : ['week', arg as string] };
    return { view: { mode: 'week', start: startOfWeek(today, weekStart) }, canonical: ['week', today] };
  }
  const view: CalView = { mode: 'month', ym: resolveMonthParam(arg, today) };
  if (params.length === 0) return { view, canonical: null };
  const want = paramsOf(view);
  const same = want.length === params.length && want.every((p, i) => p === params[i]);
  return { view, canonical: same ? null : want };
}

/** 上一页、下一页：月视图按月，周视图按周；年份超出 1900～2100 时返回 null（不翻） */
export function shiftView(view: CalView, n: number): CalView | null {
  try {
    if (view.mode === 'month') {
      const ym = shiftMonth(view.ym, n);
      return ym.y >= MIN_YEAR && ym.y <= MAX_YEAR ? { mode: 'month', ym } : null;
    }
    const start = shiftWeek(view.start, n);
    return weekInRange(start) ? { mode: 'week', start } : null;
  } catch {
    return null;
  }
}

/** “今天”：同一种视图的本月 / 本周 */
export function todayView(mode: CalView['mode'], today: DateStr, weekStart: WeekStart): CalView {
  return mode === 'month' ? { mode: 'month', ym: monthOf(today) } : { mode: 'week', start: startOfWeek(today, weekStart) };
}

/** 正显示今天所在的月 / 周吗（“今天”按钮变灰、不可点） */
export function isCurrent(view: CalView, today: DateStr, weekStart: WeekStart): boolean {
  return view.mode === 'month' ? isThisMonth(view.ym, today) : isThisWeek(view.start, today, weekStart);
}

/** 切换月 / 周：月 → 周取“今天在这个月就是本周，否则这个月 1 日那周”；周 → 月取这周第一天所在的月（跨月的周按多数天数归月） */
export function switchMode(view: CalView, today: DateStr, weekStart: WeekStart): CalView {
  if (view.mode === 'month') {
    return isThisMonth(view.ym, today) ? todayView('week', today, weekStart) : { mode: 'week', start: weekOfPickedMonth(view.ym, weekStart) };
  }
  // 一周 7 天，第 4 天（中间那天）所在的月就是多数天数所在的月
  return { mode: 'month', ym: monthOf(addDays(view.start, 3)) };
}

/** 年月选择器选了某年某月：月视图跳到那个月；周视图跳到那个月 1 日所在的那一周（R-101） */
export function pickMonth(view: CalView, ym: YearMonth, weekStart: WeekStart): CalView {
  return view.mode === 'month' ? { mode: 'month', ym } : { mode: 'week', start: weekOfPickedMonth(ym, weekStart) };
}

/** 页顶显示的年月：月视图是那个月；周视图是这周多数天数所在的月 */
export function headerMonth(view: CalView): YearMonth {
  return view.mode === 'month' ? view.ym : monthOf(addDays(view.start, 3));
}
