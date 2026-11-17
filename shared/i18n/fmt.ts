// 日期和时间格式（架构 2.4 第 2 条）：中文“10月25日 周日”，韩文“10월 25일 (일)”
// 格式模板放在词典里（fmt.*），这里只拼数字；不用 Intl 的本地化输出，保证 Node 和 Deno 结果一字不差
// 查的是网页按语言懒加载的那份公共词典（i18n.ts 的 sharedT，首屏瘦身 D 11-17）；服务器现在不用这份文件，要用时先 provideSharedDict 两份
import { DAY_MINUTES, parseDate, weekdayOf, type DateStr } from '../core/date.ts';
import { wallTime, type Tz } from '../core/tz.ts';
import { sharedT as t, type Locale } from './i18n.ts';

/** num：纯数字“11/13”（中韩写法一样，不进词典；随手记瀑布流窄卡底行，R-463） */
export type DayStyle = 'monthDay' | 'monthDayWeek' | 'num';

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
  if (style === 'num') return `${m}/${d}`;
  if (style === 'monthDay') return t('fmt.monthDay', { m, d }, locale);
  return t('fmt.monthDayWeek', { m, d, w: weekdayName(weekdayOf(dateStr), locale) }, locale);
}

/**
 * 时长（分钟）：按天、小时、分钟写，为 0 的那段不写——“13 分钟”“2 小时”“1 小时 13 分”“3 天”“2 天 9 小时 5 分”（视觉稿 kDur 加上“天”这一段，R-444）。
 * 今天页“现在”卡、同步冲突对话框共用这一份；负数、小数按四舍五入、截到 0
 */
export function fmtDur(min: number, locale: Locale): string {
  const v = Math.max(0, Math.round(min));
  const d = Math.floor(v / DAY_MINUTES);
  const h = Math.floor((v % DAY_MINUTES) / 60);
  const m = v % 60;
  const parts: string[] = [];
  if (d) parts.push(t('fmt.dur.d', { n: d }, locale));
  if (h) parts.push(t('fmt.dur.h', { n: h }, locale));
  if (m || parts.length === 0) parts.push(t(parts.length ? 'fmt.dur.mTail' : 'fmt.dur.m', { n: m }, locale));
  return parts.join(' ');
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
