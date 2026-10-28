// 时刻函数（架构 2.1、4.6，ADR-012）：凡是和“几点、哪天”有关的，tz 一律必填（A15，由类型保证）
// 纯日期运算（加减天数、星期几）只用 Date.UTC，不碰本地时区；需要“现在”的函数由调用方传 now
import { offsetMin, wallTime, type Tz } from './tz.ts';

/** 'YYYY-MM-DD' */
export type DateStr = string;

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 解析 'YYYY-MM-DD'；格式不对或日期不存在（如 2-30）时抛错 */
export function parseDate(s: DateStr): { y: number; m: number; d: number } {
  const mt = DATE_RE.exec(s);
  if (!mt) throw new Error(`bad_date:${s}`);
  const y = Number(mt[1]);
  const m = Number(mt[2]);
  const d = Number(mt[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new Error(`bad_date:${s}`);
  return { y, m, d };
}

export function fmtDateStr(y: number, m: number, d: number): DateStr {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/** 墙上时间（当作 UTC）对应的毫秒数，只用于内部换算 */
function wallAsUtc(s: DateStr, min: number): number {
  const { y, m, d } = parseDate(s);
  return Date.UTC(y, m - 1, d) + min * 60_000;
}

/**
 * 时区 tz 里 dateStr 这一天第 min 分钟（0–1439）是哪个时刻。
 * 夏令时：拨快跳过的那段时间按拨快后的时间算（2:30 → 3:30）；拨慢重复的那段取先出现的一次。
 */
export function msAt(dateStr: DateStr, min: number, tz: Tz): number {
  if (!Number.isInteger(min) || min < 0 || min >= 1440) throw new Error(`bad_min:${min}`);
  const local = wallAsUtc(dateStr, min);
  const before = offsetMin(local - DAY_MS, tz);
  const after = offsetMin(local + DAY_MS, tz);
  const valid: number[] = [];
  for (const off of new Set([before, after])) {
    const c = local - off * 60_000;
    if (offsetMin(c, tz) === off) valid.push(c);
  }
  if (valid.length > 0) return Math.min(...valid);
  // 落在跳过的那段：按转换前的偏移量算，结果比原来晚一个偏移差
  return local - before * 60_000;
}

/** 时刻 ms 在时区 tz 是哪一天 */
export function todayOf(ms: number, tz: Tz): DateStr {
  const w = wallTime(ms, tz);
  return fmtDateStr(w.y, w.m, w.d);
}

/** 时刻 ms 在时区 tz 是当天第几分钟（0–1439） */
export function minOfDay(ms: number, tz: Tz): number {
  const w = wallTime(ms, tz);
  return w.hh * 60 + w.mm;
}

/** 时刻 ms 在时区 tz 是几点（0–23） */
export function hourOf(ms: number, tz: Tz): number {
  return wallTime(ms, tz).hh;
}

/** 日期加减天数（纯日期运算，和时区无关） */
export function addDays(s: DateStr, n: number): DateStr {
  const { y, m, d } = parseDate(s);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return fmtDateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 星期几：0 = 周日 … 6 = 周六 */
export function weekdayOf(s: DateStr): number {
  const { y, m, d } = parseDate(s);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** b 比 a 晚几天（b − a） */
export function diffDays(a: DateStr, b: DateStr): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

/** 'HH:MM' → 当天第几分钟；格式不对时抛错 */
export function parseHm(hm: string): number {
  const mt = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hm);
  if (!mt) throw new Error(`bad_time:${hm}`);
  return Number(mt[1]) * 60 + Number(mt[2]);
}
