// 今日运势的生日：settings 键 cal.fortune_birth，值 {"y","m","d","h"}，纯 TS
// • 存原始的年、月、日和出生时段（h 是两小时一段的起点 23、1、3 … 21，不知道是 null），不存算好的八字：以后改算法能重算
// • 值的范围只在前端校验（不加迁移、不改表结构）：y 1901～今年（节气表从 1901 年起）、m 1～12、d 1～那个月的天数、不晚于今天、h 为 null 或 23、1～21 的奇数；
//   不合格的（同步下来的脏数据）当作没填；清除生日存成 {}，也当作没填
// • 运行日志只记 fortune set / clear，不记生日；生日不送 AI（AI 只读记录内容，读不到 settings）
import { daysIn, fmtDateStr, parseDate, type DateStr } from '../../../../shared/core/date.ts';

export const KEY_FORTUNE_BIRTH = 'cal.fortune_birth';

export interface BirthValue {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly h: number | null;
}

/** 填写层的出生时段，顺序：不知道、23–1、1–3 … 21–23 */
export const BIRTH_HOURS: readonly (number | null)[] = [null, 23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21];

/** 最早能填的年份（节气表从 1901 年起） */
export const BIRTH_MIN_YEAR = 1901;

const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** 出生时段合不合格：null，或 23、1～21 的奇数 */
export const hourOk = (h: unknown): h is number | null => h === null || h === 23 || (int(h, 1, 21) && h % 2 === 1);

/** 晚于今天（填写层把今天以后的月、日置灰；parseBirth 当作不合格） */
export const afterToday = (y: number, m: number, d: number, today: DateStr): boolean => fmtDateStr(y, m, d) > today;

/** settings 里存的值 → 生日；不合格（含晚于今天）回 null。清除生日存的是 {}，也回 null */
export function parseBirth(v: unknown, today: DateStr): BirthValue | null {
  if (typeof v !== 'object' || v === null) return null;
  const { y, m, d, h } = v as Record<string, unknown>;
  if (!int(y, BIRTH_MIN_YEAR, parseDate(today).y) || !int(m, 1, 12) || !int(d, 1, daysIn(y, m)) || !hourOk(h ?? null)) return null;
  if (afterToday(y, m, d, today)) return null;
  return { y, m, d, h: (h ?? null) as number | null };
}

/**
 * 小键盘打的年份：打两位就够（92 → 1992），打满四位也行。
 * 返回 { typed, year }：year 有值表示年份定了（键盘收起）；两位以 19、20 开头时等第三、四位
 */
export function typedYear(typed: string, maxYear: number): { readonly typed: string; readonly year: number | null } {
  if (typed.length === 4) {
    const n = Number(typed);
    return { typed, year: n >= BIRTH_MIN_YEAR && n <= maxYear ? n : null };
  }
  if (typed.length !== 2 || typed === '19' || typed === '20') return { typed, year: null };
  const n = Number(typed);
  const year = n > maxYear % 100 ? 1900 + n : 2000 + n;
  return { typed: String(year), year };
}
