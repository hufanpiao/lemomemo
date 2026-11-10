// 今天页、“最近删除”页的写入（B2 FA-2）：打勾、删除 / 撤销删除、从“最近删除”恢复；都经 core 的 edit-save（write.*），不碰 outbox
// • 打勾、取消打勾属于“其余重算”：remind 标记按 remindAtOf 传这一行现在的 remind_at（B2 任务单“接口先定”第 4 条、架构 0.54 第 2 条）
// • 打勾时改之前的提醒还没到也带标记（代码审查 S2）
// • 删除是软删（deleted_at = now，进“最近删除”，ADR-006）；撤销和恢复把 deleted_at 改回 null；都算 remind 标记（补审改法 ④）
// • “最近删除”的列表在 trash.ts（B4 拆出，不进首屏）；永久删除、全部清空在 B4 S9（0.29 续第 121 条⑧）
import { ALL_DAY_LIVE_UNTIL, remindAtOf } from '../../../../shared/logic/remind.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { saveDeleted, savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import { remindLive, rowRemindPending, todoRemindAfter, todoRemindFields, todoRemindFlag, todoRemindPendingBefore } from '../../../core/remind-flag.ts';
import type { Row } from './today-model.ts';

export type { SaveOutcome } from '../../../core/edit-save.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const isDel = (v: unknown): boolean => v !== null && v !== undefined;

/** 打勾 / 取消打勾的 remind 标记：“其余重算”，传这一行的 remind_at；改之后会响，或者改之前还会响（规则在 core/remind-flag.ts） */
export function remindAfterDone(row: Row, done: boolean, now: number, tz: Tz): boolean {
  return todoRemindFlag({ row, after: todoRemindFields(row, done), prevRemindAt: num(row['remind_at']), now, tz });
}

/** 删除 / 撤销删除的 remind 标记（补审改法 ④）：删前还会响，或者恢复后会响 */
export function remindAfterDelete(row: Row, deleted: boolean, now: number, tz: Tz): boolean {
  if (deleted) return todoRemindPendingBefore(row, now, tz);
  return todoRemindAfter(todoRemindFields(row, row['done'] === true, false), now, tz, num(row['remind_at']));
}

/** 打勾 / 取消打勾一条待办 */
export function setTodoDone(row: Row, done: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  return savePatch('todos', row.id, { done, done_at: done ? now : 0, updated_at: now }, remindAfterDone(row, done, now, tz));
}

/** 能进“最近删除”的表（B4 S2 起加随手记 notes；隐私记有自己的“最近删除”，R-193，B5） */
export type TrashTable = 'events' | 'todos' | 'notes';

/**
 * 日程这一行的提醒时刻（有时刻的按自己的 tz；全天日程按 remind_days 和 current_tz；不提醒为 null）。
 * 这里拿不到设置 remind.default_time：全天日程的当天提醒按 23:59 判断“还会不会响”，当天结束前都算会响（架构 5.3 第 4 步（11-04））
 */
function eventRemindAt(row: Row, deleted: boolean, tz: Tz): number | null {
  const date = str(row['date']);
  if (date === null) return null;
  const ev = { date, time: str(row['time']), tz: str(row['tz']), remind_min: num(row['remind_min']), remind_days: num(row['remind_days']), deleted_at: deleted ? 1 : null };
  return remindAtOf('event', ev, tz, 0, undefined, ALL_DAY_LIVE_UNTIL);
}

/** 删除 / 撤销删除、从“最近删除”恢复的 remind 标记（补审改法 ④） */
export function remindOnDelete(table: TrashTable, row: Row, deleted: boolean, now: number, tz: Tz): boolean {
  if (table === 'notes') return false;   // 随手记没有提醒
  if (table === 'todos') return remindAfterDelete(row, deleted, now, tz);
  if (deleted) {
    if (isDel(row['deleted_at'])) return false;
    return rowRemindPending(row, now) || remindLive(eventRemindAt(row, false, tz), now);
  }
  return remindLive(eventRemindAt(row, false, tz), now);
}

/** 删除（软删）/ 撤销删除、从“最近删除”恢复 */
export function setDeleted(table: TrashTable, row: Row, deleted: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  return saveDeleted(table, row.id, deleted, now, remindOnDelete(table, row, deleted, now, tz));
}
