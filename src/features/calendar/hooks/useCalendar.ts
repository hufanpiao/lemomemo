// 月历、周视图页面的 hook（B2 FA-3，架构 5.12）：路由 → 视图，读日程、待办两个集合，算月格；翻页、回今天、切月 / 周、选年月
// • “今天”按 clock.now()（带偏差校正，K8-clock）和 current_tz；每分钟看一次，跨过午夜“今天”跟着变
// • 周起始、节假日国家：读设置 cal.week_start、cal.holidays（useCalSettingValues）；没设时按界面语言取默认（前端 B 的 resolveWeekStart、holidayCountries）
// • 农历、节气：后端的 shared/logic/anniv/lunar.ts 按需加载（useLunar）；加载中、加载失败不传 dayInfo，月格照常显示、没有农历行
// • 地址参数非法或没规整（周参数不是那周第一天）时，用 replaceInPage 换成规整的（不新增历史）
// • 月格按 (年月、数据、今天、每格几个标签、节假日) 记住；周视图的排布要量出时间轴宽度，在界面一侧算（WeekView）
// • 日历内部一律原地换（R-372 ②，负责人选“算同一层（推荐）”）：翻月、切月/周、“今天”、年月选择、点某天进周视图、键盘 ← → 都用 replaceInPage，
//   不记步数，左滑直接回到进日历之前那一层（今天）
// • 节假日没拉到（离线）时 model.holidaysOffline = true，页面提示“联网后显示节假日”；韩文界面不加载农历（useLunar）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { minOfDay, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { holidayCountries, holidayYears } from '../../../../shared/logic/calendar/holidays.ts';
import { resolveWeekStart, type WeekStart, type YearMonth } from '../../../../shared/logic/calendar/cal-nav.ts';
import { buildMonth, type MonthCell } from '../../../../shared/logic/calendar/month-grid.ts';
import { replaceInPage } from '../../../app/router-levels.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { calItemsOf, todoDueMinutes, type Row } from '../data/cal-data.ts';
import { headerMonth, isCurrent, paramsOf, pickMonth, resolveView, shiftView, switchMode, todayView, type CalView } from '../data/cal-route.ts';
import { useCalSettingValues } from './useCalSettings.ts';
import { useHolidays } from './useHolidays.ts';
import { useLunar, type LunarApi } from './useLunar.ts';

const MIN = 60_000;
/** 每分钟变一次的 now（对齐整分钟） */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const n = clock.now();
      setNow(n);
      t = setTimeout(tick, MIN - (n % MIN) + 50);
    };
    t = setTimeout(tick, MIN - (clock.now() % MIN) + 50);
    return () => clearTimeout(t);
  }, []);
  return now;
}

/** 窗口够宽（电脑档）时每格 4 个标签，手机 2 个（5.12、R-100） */
const WIDE_QUERY = '(min-width: 768px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(WIDE_QUERY);
    const on = (): void => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export interface CalendarModel {
  readonly view: CalView;
  readonly today: DateStr;
  readonly tz: string;
  readonly weekStart: WeekStart;
  readonly wide: boolean;
  readonly header: YearMonth;
  readonly isCurrent: boolean;
  /** 月视图的 42 格；周视图为 null */
  readonly cells: readonly MonthCell[] | null;
  readonly items: ReturnType<typeof calItemsOf>;
  readonly holidays: ReturnType<typeof useHolidays>['marks'];
  /** 要显示的节假日文件有没拉到的（离线）：页面提示“联网后显示节假日”（5.12 第 1 点） */
  readonly holidaysOffline: boolean;
  /** 待办 id → 截止时刻（当天第几分钟）；没有截止时刻的不在表里 */
  readonly dueMins: ReadonlyMap<string, number>;
  /** 现在是当天第几分钟（设备当前时区；周视图的“现在”竖线） */
  readonly nowMin: number;
  /** 上一页、下一页还翻得动吗（1900-01 / 2100-12 到头时 false，代码审查 L3） */
  readonly canPrev: boolean;
  readonly canNext: boolean;
  readonly locale: UiLocale;
  /** 农历（读屏用完整写法）；加载中、加载失败时 null */
  readonly lunar: LunarApi | null;
}

export function useCalendar(params: readonly string[]) {
  const locale = useUi((s) => s.locale);
  const now = useMinuteNow();
  const tz = currentTz();
  const today = todayOf(now, tz);
  const setting = useCalSettingValues();
  const weekStart = resolveWeekStart(setting.weekStart, locale);
  const wide = useWide();

  const paramKey = params.join('/');
  const resolved = useMemo(() => resolveView(paramKey === '' ? [] : paramKey.split('/'), today, weekStart), [paramKey, today, weekStart]);
  const { view, canonical } = resolved;
  const canonicalKey = canonical?.join('/') ?? null;
  useEffect(() => {
    if (canonicalKey !== null) void replaceInPage('cal', ...canonicalKey.split('/'));
  }, [canonicalKey]);

  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const items = useMemo(() => calItemsOf(events, todos), [events, todos]);
  const dueMins = useMemo(() => todoDueMinutes(todos), [todos]);

  const header = headerMonth(view);
  const countryKey = holidayCountries(setting.holidays, locale).join(',');
  const countries = useMemo(() => (countryKey === '' ? [] : (countryKey.split(',') as ReturnType<typeof holidayCountries>)), [countryKey]);
  const yearKey = holidayYears(header.y, header.m).join(',');
  const years = useMemo(() => yearKey.split(',').map(Number), [yearKey]);
  const hol = useHolidays(countries, years, locale);
  const holidays = hol.marks;
  const lunar = useLunar(locale);

  const maxMarks = wide ? 4 : 2;
  // view 按地址参数记住（resolved 的 useMemo），地址不变时是同一个对象
  const cells = useMemo(() => {
    if (view.mode !== 'month') return null;
    try {
      // lunarDayInfo(date, locale) 比 MonthOpts.dayInfo(date) 多一个参数，useLunar 里包了一层：dayInfo: (date) => m.lunarDayInfo(date, locale)
      // lunar.ts 只能动态 import（useLunar 的 defaultLoad），这里和别处都不能静态 import
      return buildMonth(view.ym, items, { tz, today, weekStart, maxMarks, holidays, ...(lunar ? { dayInfo: lunar.dayInfo } : {}) });
    } catch {
      return null;
    }
  }, [view, items, tz, today, weekStart, maxMarks, holidays, lunar]);

  // 日历里翻月、切月/周、“今天”、选年月、点某天进周视图都算同一层（R-372 ②，负责人选“算同一层（推荐）”）：一律原地换，不记步数，
  // 左滑直接回到进日历之前那一层（今天）
  const go = useCallback((v: CalView | null) => {
    if (v) void replaceInPage('cal', ...paramsOf(v));
  }, []);

  const viewRef = useRef(view);
  viewRef.current = view;
  const keyShift = useCallback((n: -1 | 1) => {
    const v = shiftView(viewRef.current, n);
    if (!v) return;
    // 同一次按键事件里地址还没变：先记下新视图，连按时从它往下翻
    viewRef.current = v;
    void replaceInPage('cal', ...paramsOf(v));
  }, []);

  const model: CalendarModel = {
    view,
    today,
    tz,
    weekStart,
    wide,
    header,
    isCurrent: isCurrent(view, today, weekStart),
    cells,
    items,
    holidays,
    holidaysOffline: hol.offline,
    dueMins,
    nowMin: minOfDay(now, tz),
    canPrev: shiftView(view, -1) !== null,
    canNext: shiftView(view, 1) !== null,
    locale,
    lunar,
  };

  return {
    model,
    prev: () => go(shiftView(view, -1)),
    next: () => go(shiftView(view, 1)),
    // 周视图回今天、点某天开周视图：地址写那一天本身（L4：周起始后来变了也还落在那周）
    goToday: () => (view.mode === 'week' ? void replaceInPage('cal', 'week', today) : go(todayView(view.mode, today, weekStart))),
    setMode: (mode: CalView['mode']) => {
      if (mode !== view.mode) go(switchMode(view, today, weekStart));
    },
    pick: (ym: YearMonth) => go(pickMonth(view, ym, weekStart)),
    /** 键盘 ← →（原地换，R-372） */
    keyShift,
    /** 点月格里的某一天：跳到那一天所在的周视图 */
    openWeekOf: (date: DateStr) => void replaceInPage('cal', 'week', date),
  };
}
