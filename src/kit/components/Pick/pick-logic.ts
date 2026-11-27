// kit 选择器的纯规则（一周日期条 + 时、分两条横排）。
// 不碰 React、不碰词典，单测直接测（__tests__/pick-logic.test.ts）。日期一律 'YYYY-MM-DD'，时刻 'HH:MM'
// 一周从哪天起跟日历设置 cal.week_start 走（shared/logic/calendar/cal-nav.ts 的 startOfWeek、resolveWeekStart）；
// 时、分两条也给纪念日提醒弹层（anniv/ui/RemindSheet.tsx 的 Wheel）用，只留这一份
import { addDays, pad2, type DateStr } from '../../../../shared/core/date.ts';
import { startOfWeek, type WeekStart } from '../../../../shared/logic/calendar/cal-nav.ts';

export type PickMode = 'date' | 'time' | 'datetime';

/** 选择器里的草稿：日期、时刻都有值（只选其中一样时另一样不用） */
export interface PickValue {
  date: DateStr;
  time: string;
}

/** 没选过时刻时草稿的起点 */
export const DEFAULT_TIME = '09:00';

/** “时”那一条：00～23 */
export const HOURS: readonly string[] = Array.from({ length: 24 }, (_, i) => pad2(i));

/** “分”那一条：5 分一格；现在的分钟不在格上（如 07）就插进去、照大小排，不悄悄改掉用户原来的值 */
export function minutesOf(cur: string | undefined): string[] {
  const xs = Array.from({ length: 12 }, (_, i) => pad2(i * 5));
  if (cur !== undefined && /^[0-5]\d$/.test(cur) && !xs.includes(cur)) {
    xs.push(cur);
    xs.sort();
  }
  return xs;
}

/** 打开时的草稿：没值的日期用今天、没值的时刻用 9:00 */
export function draftOf(date: DateStr | null | undefined, time: string | null | undefined, today: DateStr): PickValue {
  return { date: date || today, time: time || DEFAULT_TIME };
}

/** 这一天所在那一周的第一天（按日历设置的周起始日） */
export const weekOf = (d: DateStr, ws: WeekStart): DateStr => startOfWeek(d, ws);

/** 在不在能选的范围外（min、max 含当天；不给就不限） */
export function outOfRange(d: DateStr, min?: DateStr, max?: DateStr): boolean {
  return (min !== undefined && d < min) || (max !== undefined && d > max);
}

/** 周箭头能不能按：这一周已经碰到 min（第一天 ≤ min）就不能往前，碰到 max（最后一天 ≥ max）就不能往后 */
export function weekArrows(first: DateStr, min?: DateStr, max?: DateStr): { prev: boolean; next: boolean } {
  return { prev: min === undefined || first > min, next: max === undefined || addDays(first, 6) < max };
}

/** 月份列表（点周标题弹出）：往前、往后各留多少个月（给了 min / max 就按它截） */
export const MONTHS_BACK = 12;
export const MONTHS_AHEAD = 24;

/** 'YYYY-MM' ↔ 月序号（y*12 + m-1），算月份加减 */
const monthIdx = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const idxMonth = (i: number): string => `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`;

/** 这一周算哪个月：最后一天所在的月（跳到某月后显示的是含 1 号的那一周，它的最后一天一定在这个月） */
export const monthOfWeek = (first: DateStr): string => addDays(first, 6).slice(0, 7);

/** 月份列表：'YYYY-MM' 从早到晚。最早 = min 所在月，没有 min 就是今天、草稿、正在看的月里最早的往前 12 个月；最晚同理 max，没有就往后 24 个月 */
export function monthSpan(first: DateStr, today: DateStr, draft: DateStr, min?: DateStr, max?: DateStr): string[] {
  const seen = [monthOfWeek(first), today.slice(0, 7), draft.slice(0, 7)].map(monthIdx);
  const lo = min !== undefined ? monthIdx(min.slice(0, 7)) : Math.min(...seen) - MONTHS_BACK;
  const hi = max !== undefined ? monthIdx(max.slice(0, 7)) : Math.max(...seen) + MONTHS_AHEAD;
  return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => idxMonth(lo + i));
}

/** 点了某个月：跳到含那个月 1 号的那一周（1 号早于 min 就跳到含 min 的那一周） */
export function monthJump(ym: string, ws: WeekStart, min?: DateStr): DateStr {
  const d = `${ym}-01`;
  return weekOf(min !== undefined && d < min ? min : d, ws);
}

/** 日期滑条上排的所有日子：从月份列表第一个月 1 号所在那一周的第一天，排到最后一个月月底所在那一周的最后一天（头尾补齐成整周，跳月、换周落点都在里面） */
export function dayRange(months: readonly string[], ws: WeekStart): DateStr[] {
  const lo = months[0];
  const hi = months[months.length - 1];
  if (lo === undefined || hi === undefined) return [];
  const [y, m] = hi.split('-').map(Number) as [number, number];
  const end = addDays(weekOf(addDays(`${y + (m === 12 ? 1 : 0)}-${pad2((m % 12) + 1)}-01`, -1), ws), 6);
  const out: DateStr[] = [];
  for (let d = weekOf(`${lo}-01`, ws); d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 两个月差几个月（运行日志只记跳了几个月，不记日子） */
export const monthDiff = (a: string, b: string): number => monthIdx(b) - monthIdx(a);

export const withHour =(time: string, h: string): string => `${h}:${time.slice(3, 5)}`;
export const withMinute = (time: string, m: string): string => `${time.slice(0, 2)}:${m}`;
