// 待办列表上的写入（B2 FA-2）：删除 / 撤销删除；经 core 的 edit-save（write.*）
// • 打勾、取消打勾在 core/todo-done.ts（和今天页、查找、提醒页同一份，评审第 15 条），这里不再写
// • 删除 / 撤销删除也算标记（补审改法 ④）：删前的提醒还没到，或者恢复后会响
import type { Tz } from '../../../../shared/core/tz.ts';
import { saveDeleted, type SaveOutcome } from '../../../core/edit-save.ts';
import { todoRemindAfter, todoRemindFields, todoRemindPendingBefore } from '../../../core/remind-flag.ts';
import type { Row } from './todo-list.ts';

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** 删除 / 撤销删除的 remind 标记（补审改法 ④）：删前还会响，或者恢复后会响 */
export function remindAfterDelete(row: Row, deleted: boolean, now: number, tz: Tz): boolean {
  if (deleted) return todoRemindPendingBefore(row, now, tz);
  return todoRemindAfter(todoRemindFields(row, row['done'] === true, false), now, tz, num(row['remind_at']));
}

export function setTodoDeleted(row: Row, deleted: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  return saveDeleted('todos', row.id, deleted, now, remindAfterDelete(row, deleted, now, tz));
}
