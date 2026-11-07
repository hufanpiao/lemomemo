// 过去的月日、几号先问再存（R-166；架构 5.1、第 7 节“年份或月份待确认”，0.29 续第 36、67、68 条；B3 任务单 BE-3）
// A 路（ai-parse、ai-voice 经 shared/schema/ai.ts）和 B 路（本机规则 shared/logic/parse/）共用这一份，两边口径一样：
//   • 看的日子：日程的 date、待办的 due；纪念日、随手记不看（纪念日按年循环，不问）；
//   • ymd、rel：用给的整个日子；这一天在那年那月不存在（2027-02-29、2026-11-31）算 bad_date；
//   • md：不用给的年份，按今天的年份配上月日；月日在任何一年都没有（11-31、02-30、04-31）算 bad_date；
//         候选不早于今天就用它、不问；早于今天加 confirm {past: 今年这天, next: 明年这天}；
//         02-29 遇上平年：取 2 月最后一天，不管过没过去都问，next 取下一个有 2 月 29 日的年份；
//   • d：不用给的年月，按今天的年月配上几号；候选不早于今天就用；早于今天加 confirm {past: 本月这天, next: 下个月这天}；
//         29～31 号遇上没有这一天的月份：取月末，不管过没过去都问，next 取下一个有这一天的月份；
//   • 最后查“今天前 1 年到后 5 年”（inAiRange），越界算 out_of_range（由调用方判断）。
// “今天”一律按请求传入的 now 和 tz 算（todayOf），不按服务器当天。纯函数，前端和 Edge Functions 共用（复制到 _shared/gen/）。
import { fmtDateStr, parseDate, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';

/** 日期是怎么说出来的：说了年份 / 只说月日 / 只说几号 / 相对说法（明天、下周三、月底、没说日子按今天记、重复说法的最近一次） */
export const DATE_BASES = ['ymd', 'md', 'd', 'rel'] as const;
export type DateBasis = (typeof DATE_BASES)[number];

/** 确认行的两个选项：past = 补记今年 / 本月的这一天（取月末时是月末），next = 明年 / 下个月有这一天的那一天 */
export interface Confirm {
  past: DateStr;
  next: DateStr;
}

export type BasisResult = { ok: true; date: DateStr; confirm: Confirm | null } | { ok: false; reason: 'bad_date' };

/** 只查格式：YYYY-MM-DD，月 01～12，日 01～31（不查这一天存不存在，0.29 续第 68 条 ①） */
export const DATE_FMT_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** 各月在闰年里的天数：月日“在任何一年都有没有”按这个判断 */
const MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** y 年 m 月有几天 */
export function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 这一天在那年那月存不存在（格式已经过 DATE_FMT_RE） */
export function dateExists(s: DateStr): boolean {
  try {
    parseDate(s);
    return true;
  } catch {
    return false;
  }
}

function split(s: DateStr): { y: number; m: number; d: number } {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

/** 从 fromYear 起第一个有 m 月 d 日的年份（只有 2 月 29 日会往后找） */
function yearWith(m: number, d: number, fromYear: number): number {
  let y = fromYear;
  while (d > daysIn(y, m)) y++;
  return y;
}

/** (y, m) 之后第一个有 d 号的月份（不含 (y, m) 本身） */
function monthAfterWith(y: number, m: number, d: number): { y: number; m: number } {
  let yy = y;
  let mm = m;
  do {
    mm++;
    if (mm > 12) {
      mm = 1;
      yy++;
    }
  } while (d > daysIn(yy, mm));
  return { y: yy, m: mm };
}

/**
 * 按 basis 把给的日子换成要存的日子，必要时带 confirm。raw 必须已过 DATE_FMT_RE（不然按 bad_date）。
 * today 是 todayOf(now, tz)。
 */
export function resolveBasis(raw: DateStr, basis: DateBasis, today: DateStr): BasisResult {
  if (!DATE_FMT_RE.test(raw)) return { ok: false, reason: 'bad_date' };
  const t = split(today);
  const r = split(raw);
  switch (basis) {
    case 'ymd':
    case 'rel':
      return dateExists(raw) ? { ok: true, date: raw, confirm: null } : { ok: false, reason: 'bad_date' };
    case 'md': {
      if (r.d > (MAX_DAY.at(r.m - 1) ?? 31)) return { ok: false, reason: 'bad_date' };   // 11-31、02-30、04-31：任何一年都没有
      if (r.d > daysIn(t.y, r.m)) {
        // 02-29 遇上平年：记 2 月最后一天，一律问
        const past = fmtDateStr(t.y, r.m, daysIn(t.y, r.m));
        return { ok: true, date: past, confirm: { past, next: fmtDateStr(yearWith(r.m, r.d, t.y + 1), r.m, r.d) } };
      }
      const cand = fmtDateStr(t.y, r.m, r.d);
      if (cand >= today) return { ok: true, date: cand, confirm: null };
      return { ok: true, date: cand, confirm: { past: cand, next: fmtDateStr(yearWith(r.m, r.d, t.y + 1), r.m, r.d) } };
    }
    case 'd': {
      const nx = monthAfterWith(t.y, t.m, r.d);
      if (r.d > daysIn(t.y, t.m)) {
        // 本月没有这一天（30 天的月说 31 号）：记月末，一律问
        const past = fmtDateStr(t.y, t.m, daysIn(t.y, t.m));
        return { ok: true, date: past, confirm: { past, next: fmtDateStr(nx.y, nx.m, r.d) } };
      }
      const cand = fmtDateStr(t.y, t.m, r.d);
      if (cand >= today) return { ok: true, date: cand, confirm: null };
      return { ok: true, date: cand, confirm: { past: cand, next: fmtDateStr(nx.y, nx.m, r.d) } };
    }
    default: {
      const never: never = basis;
      return never;
    }
  }
}

/** 同一年同一天往前、往后挪 n 年（2 月 29 日遇上平年取 28 日） */
function shiftYears(s: DateStr, n: number): DateStr {
  const { y, m, d } = split(s);
  const yy = y + n;
  return fmtDateStr(yy, m, Math.min(d, daysIn(yy, m)));
}

/** “日期在今天前 1 年到后 5 年之间”（第 7 节输出结构；今天按请求的 now、tz） */
export function inAiRange(date: DateStr, today: DateStr): boolean {
  return date >= shiftYears(today, -1) && date <= shiftYears(today, 5);
}

/** pastDate 看的那几列（AI 校验后的条目、本机规则的条目同一结构） */
export interface DatedItem {
  kind: string;
  date: DateStr | null;
  due: DateStr | null;
  date_basis: DateBasis | null;
}

export type PastDateResult<T> =
  | { ok: true; item: T & { confirm: Confirm | null } }
  | { ok: false; reason: 'bad_date' | 'out_of_range' | 'missing_date_basis' };

/**
 * 接口第 3 条 pastDate(item, now, tz)：日程看 date、待办看 due，按 basis 重配并加 confirm；别的类型原样返回、confirm 为 null。
 * 有日子却没有 basis 返回 missing_date_basis（本机规则一定带 basis；AI 的这种情况由 ai.ts 的 superRefine 先拦下）。
 */
export function pastDate<T extends DatedItem>(item: T, now: number, tz: Tz): PastDateResult<T> {
  const isEvent = item.kind === 'event';
  const raw = isEvent ? item.date : item.kind === 'todo' ? item.due : null;
  if (raw === null) return { ok: true, item: { ...item, confirm: null } };
  if (item.date_basis === null) return { ok: false, reason: 'missing_date_basis' };
  const today = todayOf(now, tz);
  const r = resolveBasis(raw, item.date_basis, today);
  if (!r.ok) return r;
  if (!inAiRange(r.date, today)) return { ok: false, reason: 'out_of_range' };
  const moved = isEvent ? { ...item, date: r.date } : { ...item, due: r.date };   // 按 kind 显式写列（check_backend F7）
  return { ok: true, item: { ...moved, confirm: r.confirm } };
}
