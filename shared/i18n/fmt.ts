// 日期和时间格式（架构 2.4 第 2 条）：中文“10月25日 周日”，韩文“10월 25일 (일)”
// 格式模板放在词典里（fmt.*），这里只拼数字；不用 Intl 的本地化输出，保证 Node 和 Deno 结果一字不差
import { parseDate, weekdayOf, type DateStr } from '../core/date.ts';
import { wallTime, type Tz } from '../core/tz.ts';
import { t, type Locale } from './i18n.ts';

export type DayStyle = 'monthDay' | 'monthDayWeek';

const WD_KEYS = ['fmt.wd.0', 'fmt.wd.1', 'fmt.wd.2', 'fmt.wd.3', 'fmt.wd.4', 'fmt.wd.5', 'fmt.wd.6'] as const;

/** 星期几的短名，i：0 = 周日 … 6 = 周六 */
export function weekdayName(i: number, locale: Locale): string {
  const key = WD_KEYS[((i % 7) + 7) % 7];
  if (!key) throw new Error(`bad_weekday:${i}`);
  return t(key, {}, locale);
}

/** 日期（不带时刻）：fmtDay('2026-10-25', 'zh-CN', 'monthDayWeek') → '10月25日 周日' */
export function fmtDay(dateStr: DateStr, locale: Locale, style: DayStyle): string {
  const { m, d } = parseDate(dateStr);
  if (style === 'monthDay') return t('fmt.monthDay', { m, d }, locale);
  return t('fmt.monthDayWeek', { m, d, w: weekdayName(weekdayOf(dateStr), locale) }, locale);
}

/** 时刻 'HH:MM'（24 小时制） */
export function fmtTime(ms: number, tz: Tz): string {
  const w = wallTime(ms, tz);
  return `${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}`;
}

/** 时刻按时区显示成日期，style 为 'time' 时只显示时刻 */
export function fmtDate(ms: number, tz: Tz, locale: Locale, style: DayStyle | 'time'): string {
  if (style === 'time') return fmtTime(ms, tz);
  const w = wallTime(ms, tz);
  const ds = `${String(w.y).padStart(4, '0')}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
  return fmtDay(ds, locale, style);
}
