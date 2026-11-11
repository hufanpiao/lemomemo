// i18n-exempt: 解析词表
// 本机规则的日期（B3 任务单 BE-2；移植 v3 parse-date-zh.js、parse-date-ko.js；架构 5.1、第 7 节“date_basis 怎么取”，0.29 续第 36、67 条）：
//   中文：今天 / 明天 / 后天 / 大后天 / 昨天 / 前天（今晚、明早带出时段提示）、周几（这 / 下 / 下下周，一律按周一起始，R-182）、
//         下个月 N 号、这个月底、带年份的日期、N月N日、M/D、N号 / N日；“3号楼”“3.5万”“版本1.5”“第3-5集”“C区35号”不当日期；
//   韩文：오늘 / 내일 / 모레（转写错字 모래）/ 글피 / 어제 / 그제、요일（이번 주 / 다음 주 / 다다음 주）、다음 달 N일、이번 달 말、N월 N일、N일；
//         后面带的“까지”（截止）和助词“에”一并取走。
// 每个日子带 basis（第 7 节）：说了年份 ymd；只说月日 md；只说几号 d；其余（相对说法、带“下个月 / 这周”参照的）rel。
// 和 v3 的差别：v3 的 monthDay、dayOnly 遇到过去的日子自己挪到明年 / 下个月，这里不挪，原样给出“今年 / 本月的这一天”，
//   由 past-date.ts 的 pastDate 按 basis 重配、出 confirm（R-166：过去的日子不替用户猜）。
//   月份本来就没有的日子（11月31号、2月30号）不认成日子，返回 bad（提示“11 月没有 31 日”，日期留空，不改成 11/30 或 12/1）。
import { addDays, fmtDateStr, weekdayOf, type DateStr } from '../../core/date.ts';
import { lastOfMonth, monthOf, shiftMonth } from '../calendar/cal-nav.ts';
import type { DateBasis } from './past-date.ts';
import { daysIn } from './past-date.ts';
import { cut, pick, take, type Rest } from './text.ts';

export type DateHit =
  | { ok: true; date: DateStr; basis: DateBasis; period: string }
  | { ok: false; bad: { month: number; day: number } };

const MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** 本周（周一起始）的周一 */
function mondayOf(t: DateStr): DateStr {
  return addDays(t, -((weekdayOf(t) + 6) % 7));
}

export type WeekPrefix = '' | '下' | '下下' | '这';
/** 周的说法：中文前缀（后面跟“周 / 星期 / 礼拜”）、韩文整词；intent.ts 的整周也用这一份 */
export const ZH_WEEK_PREFIX = '下下|下|这|本';
export const KO_WEEK = '다다음\\s*주|다음\\s*주|담주|이번\\s*주';

/** 上面两组说法对到 weekday 的 prefix；别的（含空）是 '' */
export function weekPrefix(word: string): WeekPrefix {
  const w = word.replace(/\s+/g, '');
  return w === '下' || w === '다음주' || w === '담주' ? '下' : w === '下下' || w === '다다음주' ? '下下' : w === '这' || w === '本' || w === '이번주' ? '这' : '';
}

/** 周几：wd 为 1–7（7 = 周日）；prefix 为 下 / 下下 / 这 或空（空 = 从今天起最近的那一天，今天是周五时“周五”指今天） */
export function weekday(t: DateStr, prefix: WeekPrefix, wd: number): DateStr {
  const mon = mondayOf(t);
  const idx = (wd + 6) % 7;
  if (prefix === '下') return addDays(mon, 7 + idx);
  if (prefix === '下下') return addDays(mon, 14 + idx);
  if (prefix === '这') return addDays(mon, idx);
  return addDays(t, ((wd % 7) - weekdayOf(t) + 7) % 7);
}

/** 月日：月日在任何一年都没有算 bad；有就给今年这一天（2 月 29 日遇上平年由 pastDate 处理，这里写字面日子） */
function md(t: DateStr, mo: number, d: number): DateHit | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (d > (MAX_DAY.at(mo - 1) ?? 31)) return { ok: false, bad: { month: mo, day: d } };
  return { ok: true, date: fmtDateStr(monthOf(t).y, mo, d), basis: 'md', period: '' };
}

/** 带年份：那年那月没有这一天算 bad */
function ymd(y: number, mo: number, d: number): DateHit | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (d > daysIn(y, mo)) return { ok: false, bad: { month: mo, day: d } };
  return { ok: true, date: fmtDateStr(y, mo, d), basis: 'ymd', period: '' };
}

/** 只说几号：给本月这一天的字面日子（本月没有这一天由 pastDate 取月末、出 confirm） */
function dOnly(t: DateStr, d: number): DateHit | null {
  if (d < 1 || d > 31) return null;
  const { y, m } = monthOf(t);
  return { ok: true, date: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, basis: 'd', period: '' };
}

/** 下个月 N 号（rel）：下个月没有这一天取月末 */
function nextMonthDay(t: DateStr, d: number): DateHit | null {
  if (d < 1 || d > 31) return null;
  const { y, m } = shiftMonth(monthOf(t), 1);
  return { ok: true, date: fmtDateStr(y, m, Math.min(d, daysIn(y, m))), basis: 'rel', period: '' };
}

const rel = (date: DateStr, period = ''): DateHit => ({ ok: true, date, basis: 'rel', period });
const monthEnd = (t: DateStr): DateHit => rel(lastOfMonth(monthOf(t)));

/** 取走找到的那一段并返回结果；结果为 null（不像日期）时不取走 */
function hit(st: Rest, m: RegExpMatchArray | null, h: DateHit | null): DateHit | null {
  if (!m || !h) return null;
  cut(st, m[0]);
  return h;
}

export function takeDateZh(st: Rest, t: DateStr): DateHit | null {
  let m: RegExpMatchArray | null;
  if ((m = take(st, /(大后天|后天|明天|明早|明晚|今天|今晚|今早|昨天|昨晚|前天)/))) {
    const w = m[1] ?? '';
    const period = w.endsWith('晚') ? '晚上' : w.endsWith('早') ? '早上' : '';
    const off = w === '大后天' ? 3 : w === '后天' ? 2 : w.startsWith('明') ? 1 : w.startsWith('昨') ? -1 : w === '前天' ? -2 : 0;
    return rel(addDays(t, off), period);
  }
  if ((m = take(st, new RegExp(`(${ZH_WEEK_PREFIX})?\\s*(?:个)?(?:周|星期|礼拜)\\s*([1-7])`)))) return rel(weekday(t, weekPrefix(m[1] ?? ''), Number(m[2])));
  if ((m = st.text.match(/下\s*个?\s*月\s*(\d{1,2})\s*[日号](?![楼栋室])/))) return hit(st, m, nextMonthDay(t, Number(m[1])));
  if ((m = take(st, /(?:这|本)\s*个?\s*月\s*(?:底|末)|月底/))) return monthEnd(t);
  if ((m = st.text.match(/(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*[日号]?/))) return hit(st, m, ymd(Number(m[1]), Number(m[2]), Number(m[3])));
  if ((m = st.text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?(?![楼栋室])/))) return hit(st, m, md(t, Number(m[1]), Number(m[2])));
  if ((m = st.text.match(/(?<![\d./])(\d{1,2})\/(\d{1,2})(?![\d/.])/) ?? st.text.match(/(?<![\d.第])(\d{1,2})[.-](\d{1,2})[日号]/))) {
    return hit(st, m, md(t, Number(m[1]), Number(m[2])));
  }
  if ((m = st.text.match(/(?<![\d.第A-Za-z区层栋])(\d{1,2})\s*[日号](?![楼栋室线院间])/))) return hit(st, m, dOnly(t, Number(m[1])));
  return null;
}

const KO_WEEKDAY: Readonly<Record<string, number>> = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 };
const KO_REL: Readonly<Record<string, number>> = { 오늘: 0, 내일: 1, 모레: 2, 모래: 2, 글피: 3, 어제: -1, 그제: -2, 그저께: -2 };
/** 日期后面可以跟“까지”（截止日，待办照样记 due）或助词“에” */
const TAIL = '(\\s*까지)?(?:에(?![\\uAC00-\\uD7A3]))?';

export function takeDateKo(st: Rest, t: DateStr): DateHit | null {
  let m: RegExpMatchArray | null;
  if ((m = take(st, new RegExp('(오늘|내일|모레|모래|글피|어제|그저께|그제)' + TAIL)))) return rel(addDays(t, pick(KO_REL, m[1] ?? '') ?? 0));
  if ((m = take(st, new RegExp(`(${KO_WEEK})?\\s*(월|화|수|목|금|토|일)요일` + TAIL)))) return rel(weekday(t, weekPrefix(m[1] ?? ''), pick(KO_WEEKDAY, m[2] ?? '') ?? 1));
  if ((m = st.text.match(new RegExp('다음\\s*달\\s*(\\d{1,2})\\s*일(?![요간])' + TAIL)))) return hit(st, m, nextMonthDay(t, Number(m[1])));
  if ((m = take(st, new RegExp('이번\\s*달\\s*말' + TAIL)))) return monthEnd(t);
  if ((m = st.text.match(new RegExp('(\\d{4})\\s*년\\s*(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일' + TAIL)))) return hit(st, m, ymd(Number(m[1]), Number(m[2]), Number(m[3])));
  if ((m = st.text.match(new RegExp('(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일(?![요간])' + TAIL)))) return hit(st, m, md(t, Number(m[1]), Number(m[2])));
  if ((m = st.text.match(new RegExp('(?<![\\d.])(\\d{1,2})\\s*일(?![요간])' + TAIL)))) return hit(st, m, dOnly(t, Number(m[1])));
  return null;
}
