// 待办行写入的一个入口：删除 / 撤销删除（软删，deleted_at = now，进“最近删除”，ADR-006）写在这里，打勾（./todo-done.ts）、换优先级（./todo-priority.ts）从这里转出去
// • 删除只有这一份（独立评审 11-18 二-1：原来今天页 today-actions.ts、待办页 todo-actions.ts 各写一份、逐字相同）：今天页、待办页、日历日清单、“最近删除”页、自动删除都调它
// • 删除 / 撤销删除也算 remind 标记（补审改法 ④）：删前的提醒还没到，或者恢复后会响
// • 三样合一个入口：页面经 kit/hooks/useTodoWrites.ts 第一次点时只下载这一次（一个 import()，今天页首屏预算 150 KB：每多一个 import() 就多一份预加载表）
// 纯 TS：不准 import React 和任何功能（A1）
import type { Tz } from '../../shared/core/tz.ts';
import { numOr } from '../../shared/logic/todo-row.ts';
import { saveDeleted, type SaveOutcome } from './edit-save.ts';
import { todoRemindAfter, todoRemindFields, todoRemindPendingBefore } from './remind-flag.ts';
import type { TodoRow } from './todo-done.ts';

export { doneToggler } from './todo-done.ts';
export { setTodoPriority } from './todo-priority.ts';

/** 删除 / 撤销删除的 remind 标记（补审改法 ④）：删前还会响，或者恢复后会响 */
export function remindAfterDelete(row: TodoRow, deleted: boolean, now: number, tz: Tz): boolean {
  if (deleted) return todoRemindPendingBefore(row, now, tz);
  return todoRemindAfter(todoRemindFields(row, row['done'] === true, false), now, tz, numOr(row['remind_at'], null));
}

export function setTodoDeleted(row: TodoRow, deleted: boolean, now: number, tz: Tz): Promise<SaveOutcome> {
  return saveDeleted('todos', row.id, deleted, now, remindAfterDelete(row, deleted, now, tz));
}
