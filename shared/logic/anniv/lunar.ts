// 公历 ↔ 农历换算和节气（B2 BE-5；架构 5.4“数据”、5.12 第 1 点、2.6；第 9 节单元 lunar）
// • 数据在 lunar-data.ts（tools/lunar/build.mjs 生成）。本文件静态引入它，所以界面一侧要整个按需加载本文件：
//     const lunar = await import('../../shared/logic/anniv/lunar.ts');   // 日历页、今天页显示农历时再加载，不进入口（2.6 单独 chunk）
// • 纯函数：只做纯日期运算（Date.UTC），不碰本地时区、不读“现在”；同一输入在任何进程时区结果相同（三时区测试）。
// • variant：'cn' 中国农历（香港天文台历表），'kr' 韩国阴历（KASI，数据还没到，现在一律返回 null）。
//   某国没有数据或超出覆盖范围一律返回 null，不回退成别国（架构 5.4：2051 年以后韩国阴历不显示、不报错）。
// • toSolar 只换算真实存在的日子：闰月当年没有、三十日不存在都返回 null；“用同号平月、用廿九”的兜底归 anniv.nextDate（B5，架构 5.4）。
// • 覆盖范围（中国）：公历 1901-01-20～2100-12-31。香港天文台的表从 1901-01-01 起，开头 19 天属哪个月推不出来（冬月还是闰冬月），不收；
//   2100 年腊月只知道初一（2100-12-31），大小月不知道，lunarMonthDays 返回 null。
import { fmtDateStr, parseDate, type DateStr } from '../../core/date.ts';
import type { UiLocale } from '../../i18n/pick-locale.ts';
import { LUNAR_CN, LUNAR_KR, TERMS_CN, TERMS_KR, type LunarTable, type TermTable } from './lunar-data.ts';
import { LUNAR_WORDS, SOLAR_TERM_NAMES, ZH_DAY_NAMES, ZH_MONTH_NAMES } from './lunar-names-data.ts';

/** 阴历版本：中国农历 / 韩国阴历（和 anniversaries.lunar_variant 同一套取值） */
export type LunarVariant = 'cn' | 'kr';

/** 农历日期：year 是农历年（正月初一所在的公历年），month 1～12，day 1～30 */
export interface LunarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly isLeap: boolean;
}

/** 一个农历月：start 为初一相对 1970-01-01 的天数；days 为天数（open 的月是数据里看得到的天数） */
interface MonthRow {
  readonly y: number;
  readonly m: number;
  readonly leap: boolean;
  readonly start: number;
  readonly days: number;
}

interface Decoded {
  readonly rows: readonly MonthRow[];
  /** 覆盖到哪天为止（不含） */
  readonly end: number;
  /** 最后一个月没结束 */
  readonly open: boolean;
  /** `${y}-${leap ? 'L' : ''}${m}` → rows 下标 */
  readonly index: ReadonlyMap<string, number>;
}

const DAY_MS = 86_400_000;

/** 解码结果按表缓存（输入是不变的常量表，缓存不影响结果，只省重复解码） */
const cache = new Map<LunarTable, Decoded>();

const keyOf = (y: number, m: number, leap: boolean): string => `${y}-${leap ? 'L' : ''}${m}`;

/**
 * 按下标取数组元素：不是非负整数就返回 undefined。
 * 不用方括号下标（check_backend F7：shared 拷进 Edge Functions 后，方括号里的键不许是参数、属性或算出来的数）；
 * 也不直接用 .at()，因为 .at() 遇到负数会从末尾倒着取，表前面的年份会错拿到最后一年。
 */
function itemAt<T>(arr: readonly T[], i: number): T | undefined {
  return Number.isInteger(i) && i >= 0 ? arr.at(i) : undefined;
}

function dayNumOf(date: DateStr): number {
  const { y, m, d } = parseDate(date);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function dateOfNum(n: number): DateStr {
  const t = new Date(n * DAY_MS);
  return fmtDateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 和 tools/lunar/lib.mjs 的 decodeYears 同一逻辑（tests/shared/anniv/lunar.test.ts 对拍） */
function decodeTable(t: LunarTable): Decoded {
  const hit = cache.get(t);
  if (hit) return hit;
  const rows: MonthRow[] = [];
  const pushTuple = (x: readonly [number, number, number, number, number]): void => {
    rows.push({ y: x[0], m: x[1], leap: x[2] === 1, start: x[3], days: x[4] });
  };
  t.head.forEach(pushTuple);
  t.years.forEach(([ny, bits], k) => {
    const y = t.first + k;
    const leap = (bits >> 13) & 0xf;
    const count = leap ? 13 : 12;
    let d = ny;
    let m = 1;
    for (let i = 0; i < count; i++) {
      const isLeap = leap !== 0 && i === leap;
      const days = (bits >> i) & 1 ? 30 : 29;
      rows.push({ y, m: isLeap ? leap : m, leap: isLeap, start: d, days });
      d += days;
      if (!isLeap) m++;
    }
  });
  t.tail.forEach(pushTuple);
  const index = new Map<string, number>();
  rows.forEach((r, i) => index.set(keyOf(r.y, r.m, r.leap), i));
  const out: Decoded = { rows, end: t.end, open: t.open, index };
  cache.set(t, out);
  return out;
}

/** 按版本取月表；版本不认识（类型外的值）返回 undefined，调用方当“没有数据”（代码审查建议 ②：不抛 TypeError） */
function lunarTableOf(variant: LunarVariant): LunarTable | undefined {
  switch (variant) {
    case 'cn':
      return LUNAR_CN;
    case 'kr':
      return LUNAR_KR;
    default:
      return undefined;
  }
}

function termTableOf(variant: LunarVariant): TermTable | undefined {
  switch (variant) {
    case 'cn':
      return TERMS_CN;
    case 'kr':
      return TERMS_KR;
    default:
      return undefined;
  }
}

// ── 按表计算（参数是一张 LunarTable / TermTable）：下面按版本的函数都调它们；单测拿合成表直接测，B5 的推算表也能直接用 ──

/** 表覆盖的公历范围（含两端）；空表返回 null */
export function lunarRangeIn(table: LunarTable): { readonly from: DateStr; readonly to: DateStr } | null {
  const t = decodeTable(table);
  const first = t.rows[0];
  if (!first || t.end <= first.start) return null;
  return { from: dateOfNum(first.start), to: dateOfNum(t.end - 1) };
}

/** 公历 → 农历（按表）；格式不对抛 bad_date，超出表的范围返回 null */
export function toLunarIn(table: LunarTable, date: DateStr): LunarDate | null {
  const n = dayNumOf(date);
  const { rows, end } = decodeTable(table);
  if (rows.length === 0 || n >= end || n < (rows[0]?.start ?? Infinity)) return null;
  // 二分：最后一个 start ≤ n 的月
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((itemAt(rows, mid)?.start ?? Infinity) <= n) lo = mid;
    else hi = mid - 1;
  }
  const r = itemAt(rows, lo);
  if (!r || n >= r.start + r.days) return null;
  return { year: r.y, month: r.m, day: n - r.start + 1, isLeap: r.leap };
}

/** 农历 → 公历（按表）；这一天不存在或超出范围返回 null */
export function toSolarIn(table: LunarTable, year: number, month: number, day: number, isLeap: boolean): DateStr | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 30) return null;
  const t = decodeTable(table);
  const i = t.index.get(keyOf(year, month, isLeap === true));
  const r = i === undefined ? undefined : itemAt(t.rows, i);
  if (!r || day > r.days) return null;
  const n = r.start + day - 1;
  return n < t.end ? dateOfNum(n) : null;
}

/** 农历某月的天数（按表）；没有这个月、或这个月在表的结尾还没结束返回 null */
export function lunarMonthDaysIn(table: LunarTable, year: number, month: number, isLeap: boolean): 29 | 30 | null {
  const t = decodeTable(table);
  const i = t.index.get(keyOf(year, month, isLeap === true));
  const r = i === undefined ? undefined : itemAt(t.rows, i);
  if (!r || (t.open && i === t.rows.length - 1)) return null;
  return r.days === 30 ? 30 : 29;
}

/**
 * 农历某年闰几月（按表）：0 = 没有闰月；不知道返回 null。
 * 按 y === year 的所有月找（闰腊月排在腊月后面，也找得到；代码审查 M1）。不知道的情况：
 * 正月或腊月不在表里（1900 年只有腊月）；或者这一年没找到闰月、而表在这一年的腊月后面就结束了（open），闰腊月可能在表外（2100 年）。
 */
export function leapMonthIn(table: LunarTable, year: number): number | null {
  const t = decodeTable(table);
  const from = t.index.get(keyOf(year, 1, false));
  if (from === undefined || !t.index.has(keyOf(year, 12, false))) return null;
  let i = from;
  for (; i < t.rows.length && itemAt(t.rows, i)?.y === year; i++) {
    const r = itemAt(t.rows, i);
    if (r?.leap) return r.m;
  }
  // 走到了表的最后一行还在这一年，而且最后一个月没结束：后面有没有闰腊月不知道
  if (i === t.rows.length && t.open) return null;
  return 0;
}

/** 某天是第几个节气（按表）；不是或该年没有数据返回 null */
export function solarTermIn(table: TermTable, date: DateStr): SolarTermIndex | null {
  const { y, m, d } = parseDate(date);
  const offs = itemAt(table.years, y - table.first);
  if (!offs) return null;
  const off = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY_MS);
  const i = offs.indexOf(off);
  return i >= 0 ? i : null;
}

/** 某公历年的 24 个节气日期（按表）；没有数据返回 null */
export function solarTermsOfYearIn(table: TermTable, year: number): readonly DateStr[] | null {
  const offs = itemAt(table.years, year - table.first);
  if (!offs) return null;
  const base = Math.round(Date.UTC(year, 0, 1) / DAY_MS);
  return offs.map((o) => dateOfNum(base + o));
}

// ── 按版本（界面和 anniv 用这些）：版本不认识或该国没有数据一律返回 null ──

/** 某个版本的农历数据覆盖的公历范围（含两端）；没有数据返回 null */
export function lunarRange(variant: LunarVariant): { readonly from: DateStr; readonly to: DateStr } | null {
  const t = lunarTableOf(variant);
  return t ? lunarRangeIn(t) : null;
}

/** 公历 → 农历；格式不对抛 bad_date，超出覆盖范围或该国没有数据返回 null */
export function toLunar(date: DateStr, variant: LunarVariant): LunarDate | null {
  const t = lunarTableOf(variant);
  if (!t) {
    parseDate(date);   // 版本不对也照样校验日期格式，行为和有数据时一致
    return null;
  }
  return toLunarIn(t, date);
}

/**
 * 农历 → 公历（架构 5.4 的 toSolar(年, month, day, is_leap, variant)）。
 * 这一天不存在（闰月当年没有、小月没有三十、超出覆盖范围、该国没有数据）返回 null；参数不是整数也返回 null。
 */
export function toSolar(year: number, month: number, day: number, isLeap: boolean, variant: LunarVariant): DateStr | null {
  const t = lunarTableOf(variant);
  return t ? toSolarIn(t, year, month, day, isLeap) : null;
}

/** 农历某月的天数（29 或 30）；没有这个月、或这个月在数据结尾还没结束（2100 年腊月）返回 null */
export function lunarMonthDays(year: number, month: number, isLeap: boolean, variant: LunarVariant): 29 | 30 | null {
  const t = lunarTableOf(variant);
  return t ? lunarMonthDaysIn(t, year, month, isLeap) : null;
}

/** 农历某年闰几月：0 = 没有闰月；不知道（这一年不完整、该国没有数据）返回 null。新建纪念日的“闰月”开关只在有这个闰月时可开 */
export function leapMonthOf(year: number, variant: LunarVariant): number | null {
  const t = lunarTableOf(variant);
  return t ? leapMonthIn(t, year) : null;
}

/** 节气：0 = 小寒 … 23 = 冬至（从小寒起，和 SOLAR_TERM_NAMES 同序） */
export type SolarTermIndex = number;

/** 公历某天是不是节气交节日；是就返回节气序号，不是或该年没有数据返回 null。日期按该国历法时区划（中国东八区、韩国东九区） */
export function solarTermOf(date: DateStr, variant: LunarVariant): SolarTermIndex | null {
  const t = termTableOf(variant);
  if (!t) {
    parseDate(date);
    return null;
  }
  return solarTermIn(t, date);
}

/** 某公历年的 24 个节气日期（从小寒起）；没有数据返回 null */
export function solarTermsOfYear(year: number, variant: LunarVariant): readonly DateStr[] | null {
  const t = termTableOf(variant);
  return t ? solarTermsOfYearIn(t, year) : null;
}

/** 24 节气名（中、韩），从小寒起；文字在 lunar-names-data.ts */
export { SOLAR_TERM_NAMES };

/** 中文农历日：初一…初十、十一…二十、廿一…廿九、三十 */
function zhDay(d: number): string {
  return itemAt(ZH_DAY_NAMES, d - 1) ?? '';
}

/** 农历月名：中文“正月”“闰二月”“冬月”“腊月”；韩文“1월”“윤2월” */
export function lunarMonthName(month: number, isLeap: boolean, locale: UiLocale): string {
  if (locale === 'ko-KR') return `${isLeap ? LUNAR_WORDS.koLeap : ''}${month}${LUNAR_WORDS.koMonth}`;
  return `${isLeap ? LUNAR_WORDS.zhLeap : ''}${itemAt(ZH_MONTH_NAMES, month - 1) ?? ''}`;
}

/** 完整写法：中文“九月十五”“闰二月十一”；韩文“9월 15일”“윤2월 11일”（前面要不要加“农历 / 음력”由界面定） */
export function lunarText(l: LunarDate, locale: UiLocale): string {
  if (locale === 'ko-KR') return `${lunarMonthName(l.month, l.isLeap, locale)} ${l.day}${LUNAR_WORDS.koDay}`;
  return `${lunarMonthName(l.month, l.isLeap, locale)}${zhDay(l.day)}`;
}

/** 月历格子里的短写法：初一显示月名（“九月”“闰二月”/“9월”“윤2월”），其余显示日（“十五”/“9.15”“윤2.11”） */
export function lunarCellText(l: LunarDate, locale: UiLocale): string {
  if (l.day === 1) return lunarMonthName(l.month, l.isLeap, locale);
  if (locale === 'ko-KR') return `${l.isLeap ? LUNAR_WORDS.koLeap : ''}${l.month}.${l.day}`;
  return zhDay(l.day);
}

/**
 * 月历 dayInfo（shared/logic/calendar/month-grid.ts 的 MonthOpts.dayInfo）一天的文字：农历短写法和节气名。
 * 版本按界面语言：中文界面用中国的，韩文界面用韩国的（架构 5.4）。没有数据的那一项不给（韩国 2051 年以后不显示农历行、不报错）。
 */
export function lunarDayInfo(date: DateStr, locale: UiLocale): { readonly lunar?: string; readonly solarTerm?: string } {
  const variant: LunarVariant = locale === 'ko-KR' ? 'kr' : 'cn';
  const l = toLunar(date, variant);
  const t = solarTermOf(date, variant);
  return {
    ...(l === null ? {} : { lunar: lunarCellText(l, locale) }),
    ...(t === null ? {} : { solarTerm: itemAt(variant === 'kr' ? SOLAR_TERM_NAMES['ko-KR'] : SOLAR_TERM_NAMES['zh-CN'], t) ?? '' }),
  };
}
