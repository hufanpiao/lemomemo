// 待办列表上的写入（B2 FA-2）：打勾、删除 / 撤销删除；经 core 的 edit-save（write.*）
// • 打勾、取消打勾是“其余重算”：remind 标记按 remindAtOf 传这一行现在的 remind_at（“接口先定”第 4 条、架构 0.54 第 2 条）；
//   改之前的提醒还没到也带标记（代码审查 S2）
// • 删除 / 撤销删除也算标记（补审改法 ④）：删前的提醒还没到，或者恢复后会响
// • 和 today/data/today-actions.ts 的打勾是同一条规则，都调 core/remind-flag.ts（代码审查 S15）
import type { Tz } from '../../../../shared/core/tz.ts';
import { saveDeleted, savePatch, type SaveOutcome } from '../../../core/edit-save.ts';
import { todoRemindAfter, todoRemindFields, todoRemindFlag, todoRemindPendingBefore } from '../../../core/remind-flag.ts';
import type { Row } from './todo-list.ts';

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** 打勾 / 取消打勾的 remind 标记：“其余重算”，传这一行的 remind_at；改之后会响，或者改之前还会响（规则在 core/remind-flag.ts） */
export function remindAfterDone(row: Row, done: boolean, now: number, tz: Tz): boolean {
  return todoRemindFlag({ row, after: todoRemindFields(row, done), prevRemindAt: num(row['remind_at']), now, tz });
}

/** 删除 / 撤销删除的 remind 标记（补审改法 ④）：删前还会响，或者恢复后会响 */
export function remindAfterDelete(row: Row, deleted: boolean, now: number, tz: Tz): boolean {
  if (deleted) return todoRemindPendingBefore(row, now, tz);
  return todoRemindAfter(todoRemindFields(row, row['done'] === true, false), now, tz, num(row['remind_at']));
}

export function setTodoDone(row: Row, done: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  return savePatch('todos', row.id, { done, done_at: done ? now : 0, updated_at: now }, remindAfterDone(row, done, now, tz));
}

export function setTodoDeleted(row: Row, deleted: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  return saveDeleted('todos', row.id, deleted, now, remindAfterDelete(row, deleted, now, tz));
}
