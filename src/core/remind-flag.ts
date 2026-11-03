// 待办写入的 remind 标记（outbox 据此整条提前发；B2 代码审查 S2、S14～S16）：编辑页（todos/data/todo-edit.ts）、今天页（today/data/today-actions.ts）、
// 待办页（todos/data/todo-actions.ts）三处共用这一份（S15：功能之间不能互相 import，A27，规则只在这里改；日程的编辑页、今天页也用 remindLive、rowRemindPending）。纯函数，不碰库
// • 改之后：用 shared/logic/remind.ts 的 remindAtOf 现算（和服务器同一份），算得出、且不早于 now − 宽限才算会响（S16：改个备注不该让很久以前的逾期待办整条提前发）
// • 改之前：这一行没删，且下面任何一个不早于 now − 宽限，就算“还会响”，撤掉它的写入要尽快上服务器：
//   ① 按字段、传它自己的 remind_at 重算出来的时刻（S2）；② 服务器上的 remind_at（S14：按过“稍后”时，它是还没到的稍后时刻，按字段重算算不出来）；
//   ③ snooze_at（S14，同上）
// • 宽限 2 分钟：push-dispatch 每分钟跑一次，刚过的提醒可能还没推，这时撤掉它的写入也要尽快送到（“≥ now − 2 分钟”）
import type { Tz } from '../../shared/core/tz.ts';
import { remindAtOf, type TodoRemindRow } from '../../shared/logic/remind.ts';

export const REMIND_PENDING_GRACE_MS = 2 * 60 * 1000;

type RowLike = Readonly<Record<string, unknown>>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const isDel = (v: unknown): boolean => v !== null && v !== undefined;
/** 这个提醒时刻还算不算会响：不早于 now − 宽限（日程、待办都用） */
export const remindLive = (at: number | null, now: number): boolean => at !== null && at >= now - REMIND_PENDING_GRACE_MS;
const live = remindLive;

/** 服务器上这一行的 remind_at、snooze_at 有没有还会响的（S14：按过“稍后”，按字段重算算不出来；日程、待办都用）。已删的行不算 */
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

/**
 * 改之前这一行的提醒还会不会响（见文件头 ①②③）。fields 不给就按行里现在的字段；已删的行不算
 */
export function todoRemindPendingBefore(row: RowLike | undefined, now: number, tz: Tz, fields?: TodoRemindRow): boolean {
  if (row === undefined || isDel(row['deleted_at'])) return false;
  if (rowRemindPending(row, now)) return true;
  return live(remindAtOf('todo', fields ?? todoRemindFields(row), tz, now, num(row['remind_at'])), now);
}

/** 改之后会不会响：prevRemindAt 照 shared/logic/remind.ts 文件头 ①②（新建、改了截止或提前量不传） */
export function todoRemindAfter(fields: TodoRemindRow, now: number, tz: Tz, prevRemindAt: number | null | undefined): boolean {
  return live(remindAtOf('todo', fields, tz, now, prevRemindAt), now);
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
