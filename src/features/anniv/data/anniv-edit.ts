// 纪念日编辑的规则（B5 S14、S15；架构 5.4；线框 s5、皮肤视觉稿 annnew / annedit / annface；R-94、R-403；代定 D1、D15）：纯 TS（A1）
// 推算和农历经 anniv-lib.ts 按需加载（2.6）：这里的函数只在纪念日页面、编辑、提醒设置加载好 lib 以后才调
// • 表单 ↔ 行：类型、名字、阳历 / 阴历、月日、闰月、年份（null = 不知道年份）、提醒（null = 用设置里的默认，“恢复默认”写回 null）、
//   倒数日到期后（移到已过去 / 每年重复）、备注。韩国阴历不给选（D1），新建一律 'cn'
// • 提醒提前天数在表单里存成 "7,1" 这样的字符串（kit 的 useEditRecord 按 Object.is 比字段，数组每次都是新的会被当成改了）
// • 日期只让选存在的（年份决定闰月有没有、农历这个月 29 还是 30 天、阳历 2 月 28 还是 29）；改了月份、年份以后日子超出就收到最后一天（normalize）。
//   存之前再用 validDate 核一次，不合格的不写（R-403“不存在的月日保存时拒”）
// • 闰月（D15）：只有真有闰月的年份，月份那一列才出现“闰X月”（和平月同一列）；不知道年份时不给闰月。选了闰月只显示一行
//   “没有闰月的年份按同号平月过”，不给选项
// • remind 标记（整条提前发，4.2）：改之后算得出、还没过的提醒（next-date 的 annivNextAt，按出厂默认算就够判断“会不会响”），
//   或者改之前服务器上的 remind_at / snooze_at 还会响（core 的 rowRemindPending）
import { daysIn, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import type { AfterDue, AnnivCalendar, AnnivKind, AnnivRec } from '../../../../shared/logic/anniv/next-date.ts';
import { saveDeleted, type SaveOutcome } from '../../../core/edit-save.ts';
import { remindLive, rowRemindPending } from '../../../core/remind-flag.ts';
import { annivLib } from './anniv-lib.ts';

export const NAME_MAX = 60;
export const NOTE_MAX = 2000;
/** 农历表的范围（1901-01-20～2100-12-31）：阴历年份只给 1901～2099 */
export const LUNAR_YEAR_MIN = 1901;
export const LUNAR_YEAR_MAX = 2099;

export interface AnnivForm {
  kind: AnnivKind;
  name: string;
  calendar: AnnivCalendar;
  month: number;
  day: number;
  is_leap: boolean;
  /** null = 不知道年份 */
  year: number | null;
  /** 提前几天，"7,1"（从大到小）；null = 用默认 */
  offsets: string | null;
  /** 'HH:MM'；null = 用默认 */
  time: string | null;
  after_due: AfterDue;
  note: string;
}

type RowLike = Readonly<Record<string, unknown>>;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 提前天数数组 ↔ 表单里的字符串：去重、只留 0～60 的整数、从大到小、最多 4 个；一个都没有回 null */
export function offsetsKey(xs: readonly unknown[] | null): string | null {
  if (!xs) return null;
  const { OFFSET_MAX, OFFSETS_MAX } = annivLib();
  const ok = [...new Set(xs.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= OFFSET_MAX))].sort((a, b) => b - a);
  return ok.length ? ok.slice(0, OFFSETS_MAX).join(',') : null;
}
export function offsetsList(key: string | null): number[] | null {
  return key === null ? null : key.split(',').map(Number);
}

export function formOf(row: RowLike): AnnivForm {
  const kind = row['kind'];
  return {
    kind: kind === 'anniversary' || kind === 'countdown' ? kind : 'birthday',
    name: str(row['name']),
    calendar: row['calendar'] === 'lunar' ? 'lunar' : 'solar',
    month: num(row['month'], 1),
    day: num(row['day'], 1),
    is_leap: row['is_leap'] === true,
    year: typeof row['year'] === 'number' ? row['year'] : null,
    offsets: offsetsKey(Array.isArray(row['remind_offsets']) ? row['remind_offsets'] : null),
    time: typeof row['remind_time'] === 'string' ? row['remind_time'] : null,
    after_due: row['after_due'] === 'yearly' ? 'yearly' : 'archive',
    note: str(row['note']),
  };
}

/** 新建：今天的月日、阳历、生日；年份不填（生日要用户自己选年份，“不知道年份”默认关着时给今年） */
export function emptyForm(today: DateStr): AnnivForm {
  return {
    kind: 'birthday', name: '', calendar: 'solar', month: Number(today.slice(5, 7)), day: Number(today.slice(8, 10)), is_leap: false,
    year: Number(today.slice(0, 4)), offsets: null, time: null, after_due: 'archive', note: '',
  };
}

/** 这一年（阴历）的闰月；不知道年份、超出表范围为 null */
export function leapOf(calendar: AnnivCalendar, year: number | null): number | null {
  if (calendar !== 'lunar' || year === null) return null;
  try {
    return annivLib().leapMonthOf(year, 'cn');
  } catch {
    return null;
  }
}

/** 这个月最多几天：阳历按年份（不知道年份按闰年，2-29 也能选）；阴历按那一年那个月（不知道年份按 30） */
export function maxDay(f: Pick<AnnivForm, 'calendar' | 'year' | 'month' | 'is_leap'>): number {
  if (f.calendar === 'solar') return daysIn(f.year ?? 2000, f.month);
  if (f.year === null) return 30;
  try {
    return annivLib().lunarMonthDays(f.year, f.month, f.is_leap, 'cn') ?? 30;
  } catch {
    return 30;
  }
}

/** 年份选项（阴历只给农历表里有的年份） */
export function yearRange(calendar: AnnivCalendar): { min: number; max: number } {
  const L = annivLib();
  return calendar === 'lunar' ? { min: LUNAR_YEAR_MIN, max: LUNAR_YEAR_MAX } : { min: L.YEAR_MIN, max: L.YEAR_MAX };
}

/** 改完以后收拾：闰月那一年没有了就改平月，日子超出这个月就收到最后一天，年份超出范围就收进来 */
export function normalize(f: AnnivForm): AnnivForm {
  const out = { ...f };
  if (out.year !== null) {
    const r = yearRange(out.calendar);
    out.year = Math.min(r.max, Math.max(r.min, out.year));
  }
  if (out.calendar === 'solar' || (out.is_leap && leapOf(out.calendar, out.year) !== out.month)) out.is_leap = false;
  out.day = Math.min(out.day, maxDay(out));
  return out;
}

export function recOf(f: AnnivForm, createdAt: number | null): AnnivRec {
  return {
    kind: f.kind, calendar: f.calendar, lunar_variant: 'cn', month: f.month, day: f.day, is_leap: f.is_leap, year: f.year,
    after_due: f.after_due, remind_offsets: offsetsList(f.offsets), remind_time: f.time, created_at: createdAt,
  };
}

/** 月日存在吗（R-403） */
export function dateValid(f: AnnivForm): boolean {
  return annivLib().validDate(recOf(f, null));
}

const COLS: readonly [keyof AnnivForm, string, (f: AnnivForm) => unknown][] = [
  ['kind', 'kind', (f) => f.kind],
  ['name', 'name', (f) => f.name.trim()],
  ['calendar', 'calendar', (f) => f.calendar],
  ['month', 'month', (f) => f.month],
  ['day', 'day', (f) => f.day],
  ['is_leap', 'is_leap', (f) => f.is_leap],
  ['year', 'year', (f) => f.year],
  ['offsets', 'remind_offsets', (f) => offsetsList(f.offsets)],
  ['time', 'remind_time', (f) => f.time],
  ['after_due', 'after_due', (f) => f.after_due],
  ['note', 'note', (f) => f.note],
];

/** 改了的列；没改回 null。月日合不合格由 hooks 先查（dateValid） */
export function patchOf(_row: RowLike, prev: AnnivForm, next: AnnivForm, now: number): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, col, val] of COLS) if (!Object.is(prev[k], next[k])) out[col] = val(next);
  if (Object.keys(out).length === 0) return null;
  out['updated_at'] = now;
  return out;
}

export function newRow(id: string, f: AnnivForm, now: number): Record<string, unknown> & { id: string } {
  const row: Record<string, unknown> & { id: string } = { id, lunar_variant: 'cn', created_at: now, updated_at: now };
  for (const [, col, val] of COLS) row[col] = val(f);
  return row;
}

/** remind 标记（见文件头） */
export function hasRemind(c: { row: RowLike | undefined; next: AnnivForm; data: Readonly<Record<string, unknown>> | null; tz: Tz; now: number }): boolean {
  const { annivNextAt, validDate } = annivLib();
  const deleted = c.data && 'deleted_at' in c.data ? c.data['deleted_at'] !== null : (c.row?.['deleted_at'] ?? null) !== null;
  if (!deleted && validDate(recOf(c.next, null))) {
    const created = typeof c.row?.['created_at'] === 'number' ? c.row['created_at'] : c.now;
    try {
      if (remindLive(annivNextAt(recOf(c.next, created), c.tz, c.now, {}).remind_at, c.now)) return true;
    } catch {
      // 算不出就按“不会响”，只看改之前
    }
  }
  return rowRemindPending(c.row, c.now);
}

/** 列表左滑删除 / 撤销删除（软删，进“最近删除”）；remind 标记同编辑页（删前还会响，或者恢复后会响） */
export function setAnnivDeleted(row: RowLike & { readonly id: string }, deleted: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  const remind = hasRemind({ row, next: formOf(row), data: { deleted_at: deleted ? now : null }, tz, now });
  return saveDeleted('anniversaries', row.id, deleted, now, remind);
}
