// 写入的 remind 标记（outbox 据此整条提前发）和“行 → 提醒字段”，待办、日程、纪念日都只在这里定，别处不另写一份。
// 编辑页、删除和“最近删除”、打勾、冲突卡恢复、打字条新建、提醒列表现算时刻都用它；功能之间不能互相 import，所以放 core。纯函数，不碰库
// • 改之后：用 shared/logic/remind.ts 的 remindAtOf 现算（和服务器同一份），算得出、且不早于 now − 宽限才算会响（改个备注不该让很久以前的逾期待办整条提前发）
// • 改之前：这一行没删，且下面任何一个不早于 now − 宽限，就算“还会响”，撤掉它的写入要尽快上服务器：
//   ① 按字段、传它自己的 remind_at 重算出来的时刻；② 服务器上的 remind_at（按过“稍后”时，它是还没到的稍后时刻，按字段重算算不出来）；
//   ③ snooze_at（同上）
// • 宽限 2 分钟：push-dispatch 每分钟跑一次，刚过的提醒可能还没推，这时撤掉它的写入也要尽快送到（“≥ now − 2 分钟”）
// • 日程判断“还会不会响”时，全天日程的当天提醒按 23:59（ALL_DAY_LIVE_UNTIL）算：这里拿不到设置 remind.default_time，当天结束前都算会响
// • 纪念日按出厂默认算就够判断会不会响；推算库按需加载（core/anniv-lib.ts），由调用方加载好传进来
import { isDel, numOr, strOrNull as str } from '../../shared/core/field.ts';
import type { Tz } from '../../shared/core/tz.ts';
import type * as NextNs from '../../shared/logic/anniv/next-date.ts';
import type { AnnivRec } from '../../shared/logic/anniv/next-date.ts';
import { ALL_DAY_LIVE_UNTIL, remindAtOf, type EventRemindRow, type TodoRemindRow } from '../../shared/logic/remind.ts';

/** 只要推算库里这两个函数；类型直接取 shared，不引 core/anniv-lib.ts——它引 src/platform（import.meta.env），
 *  reminder-model 被服务器测试 push-dispatch-d3.it.ts 用 Deno 类型检查，引到就报 TS2339 */
type AnnivRemindLib = Pick<typeof NextNs, 'validDate' | 'annivNextAt'>;

export const REMIND_PENDING_GRACE_MS = 2 * 60 * 1000;

type RowLike = Readonly<Record<string, unknown>>;

const num = (v: unknown): number | null => numOr(v, null);
/** 这个提醒时刻还算不算会响：不早于 now − 宽限（日程、待办都用） */
export const remindLive = (at: number | null, now: number): boolean => at !== null && at >= now - REMIND_PENDING_GRACE_MS;
const live = remindLive;

/** 服务器上这一行的 remind_at、snooze_at 有没有还会响的（按过“稍后”，按字段重算算不出来；日程、待办都用）。已删的行不算 */
export function rowRemindPending(row: RowLike | undefined, now: number): boolean {
  if (row === undefined || isDel(row['deleted_at'])) return false;
  return live(num(row['remind_at']), now) || live(num(row['snooze_at']), now);
}

/** 行里的提醒字段（done、deleted 可换） */
export function todoRemindFields(row: RowLike, done = row['done'] === true, deleted = isDel(row['deleted_at'])): TodoRemindRow {
  return {
    due: str(row['due']),
    due_time: str(row['due_time']),
    remind_before_min: num(row['remind_before_min']),
    remind_days: num(row['remind_days']),
    remind_time: str(row['remind_time']),
    done,
    deleted_at: deleted ? 1 : null,
  };
}

/** 改之前这一行的提醒还会不会响（见文件头 ①②③）。fields 不给就按行里现在的字段；已删的行不算 */
export function todoRemindPendingBefore(row: RowLike | undefined, now: number, tz: Tz, fields?: TodoRemindRow): boolean {
  if (row === undefined || isDel(row['deleted_at'])) return false;
  if (rowRemindPending(row, now)) return true;
  return live(remindAtOf('todo', fields ?? todoRemindFields(row), tz, now, num(row['remind_at'])), now);
}

/** 改之后会不会响：prevRemindAt 照 shared/logic/remind.ts 文件头 ①②（新建、改了截止或提前量不传） */
export function todoRemindAfter(fields: TodoRemindRow, now: number, tz: Tz, prevRemindAt: number | null | undefined): boolean {
  return live(remindAtOf('todo', fields, tz, now, prevRemindAt), now);
}

/**
 * 决定“回落到截止时刻”的列（shared/logic/remind.ts 文件头 ①：新建、改了截止日期 / 截止时刻 / 提前量时不传 prevRemindAt）。
 * 一个 patch 里只要含其中一列就不传
 */
export const TODO_TIMING_COLS: readonly string[] = ['due', 'due_time', 'remind_before_min'];

/**
 * 待办这次写入给 remindAtOf 的 prevRemindAt：
 * 新建（data 为 null 或没有原行）、改了 TODO_TIMING_COLS 里的列 → undefined（不传）；其余 → 这一行现在的 remind_at（本机新建、还没同步回来的行没有这一列，按 null）
 */
export function todoPrevRemindAt(row: RowLike | undefined, data: RowLike | null): number | null | undefined {
  if (data === null || row === undefined) return undefined;
  if (TODO_TIMING_COLS.some((c) => c in data)) return undefined;
  return num(row['remind_at']);
}

/** 日程行（或表单）里的提醒字段；没有日子（date 不是字符串）为 null。deleted 可换 */
export function eventRemindFields(row: RowLike, deleted = isDel(row['deleted_at'])): EventRemindRow | null {
  const date = str(row['date']);
  if (date === null) return null;
  return { date, time: str(row['time']), tz: str(row['tz']), remind_min: num(row['remind_min']), remind_days: num(row['remind_days']), deleted_at: deleted ? 1 : null };
}

/** 日程的提醒时刻（有时刻的按自己的 tz；全天日程按 tz = current_tz 和 defaultTime = 设置 remind.default_time，不传按 09:00）；不提醒为 null */
export function eventRemindAt(f: EventRemindRow | null, tz: Tz, now: number, defaultTime: unknown): number | null {
  return f === null ? null : remindAtOf('event', f, tz, now, undefined, defaultTime);
}

/** 日程按字段算的提醒还会不会响（全天日程当天提醒按 23:59 判断，见文件头） */
export function eventRemindLive(f: EventRemindRow | null, tz: Tz, now: number): boolean {
  return live(eventRemindAt(f, tz, now, ALL_DAY_LIVE_UNTIL), now);
}

/** 日程改之前还会不会响：没删，且服务器上的 remind_at、snooze_at 还会响，或按字段（fields 不给按行里的）算出的还会响 */
export function eventRemindPendingBefore(row: RowLike | undefined, now: number, tz: Tz, fields?: EventRemindRow | null): boolean {
  if (row === undefined || isDel(row['deleted_at'])) return false;
  return rowRemindPending(row, now) || eventRemindLive(fields === undefined ? eventRemindFields(row, false) : fields, tz, now);
}

/** 纪念日这一次提醒还会不会响（按出厂默认）：rec 为 null、月日不存在、推算抛错都按不会响 */
export function annivRemindLive(lib: AnnivRemindLib,rec: AnnivRec | null, tz: Tz, now: number): boolean {
  if (rec === null || !lib.validDate(rec)) return false;
  try {
    return live(lib.annivNextAt(rec, tz, now, {}).remind_at, now);
  } catch {
    return false;
  }
}

/** 写入的 remind 标记：改之后会响，或者改之前还会响 */
export function todoRemindFlag(c: {
  row: RowLike | undefined;
  after: TodoRemindRow;
  prevRemindAt: number | null | undefined;
  now: number;
  tz: Tz;
  /** 改之前的字段（编辑页用表单那一份）；不给按行里的 */
  before?: TodoRemindRow | undefined;
}): boolean {
  return todoRemindAfter(c.after, c.now, c.tz, c.prevRemindAt) || todoRemindPendingBefore(c.row, c.now, c.tz, c.before);
}
