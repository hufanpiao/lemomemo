// 待办行写入的一个入口：删除 / 撤销删除（软删，deleted_at = now，进“最近删除”，ADR-006）写在这里，打勾（./todo-done.ts）、换优先级（./todo-priority.ts）从这里转出去
// • 删除只有这一份（独立评审 11-18 二-1：原来今天页 today-actions.ts、待办页 todo-actions.ts 各写一份、逐字相同）：今天页、待办页、日历日清单、“最近删除”页、自动删除都调它
// • 删除 / 撤销删除也算 remind 标记（补审改法 ④）：删前的提醒还没到，或者恢复后会响
// • 推迟到明天（负责人 11-21“没赶上的加一个推迟按钮，按一下把时间推迟到明天”）和它的撤销也在这里：只改截止日 due，截止时刻、提前量、
//   当天 / 前一天提醒都不动；提醒是按截止算出来的（shared/logic/remind.ts），截止挪了提醒自然跟着挪，不另写一份。remind 标记同编辑页改截止日
//   （todos/data/todo-edit.ts 的 hasRemind：改了截止日不传 prevRemindAt，改之后会响或改之前还会响）。重复待办（repeat 不为空）本版只读，写之前已被只读拦下
// • 三样合一个入口：页面经 kit/hooks/useTodoWrites.ts 第一次点时只下载这一次（一个 import()，今天页首屏预算 150 KB：每多一个 import() 就多一份预加载表）
// 纯 TS：不准 import React 和任何功能（A1）
import { addDays, todayOf, type DateStr } from '../../shared/core/date.ts';
import type { Tz } from '../../shared/core/tz.ts';
import { numOr } from '../../shared/logic/todo-row.ts';
import { saveDeleted, savePatch, type SaveOutcome } from './edit-save.ts';
import { todoRemindAfter, todoRemindFields, todoRemindFlag, todoRemindPendingBefore } from './remind-flag.ts';
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

/** “明天”：按用户时区（current_tz，待办截止是浮动的，架构 4.6）的今天加一天 */
export const tomorrowOf = (now: number, tz: Tz): DateStr => addDays(todayOf(now, tz), 1);

/** 把截止日改成 due 要写的列和 remind 标记（不写库）：推迟到明天、撤销推迟都用它 */
export function todoDuePatch(row: TodoRow, due: DateStr, now: number, tz: Tz): { data: { due: DateStr; updated_at: number }; remind: boolean } {
  const remind = todoRemindFlag({ row, after: { ...todoRemindFields(row), due }, prevRemindAt: undefined, now, tz });
  return { data: { due, updated_at: now }, remind };
}

type Save = (table: string, id: string, data: Record<string, unknown>, remind: boolean) => Promise<SaveOutcome>;

export function setTodoDue(row: TodoRow, due: DateStr, now: number, tz: Tz, save: Save = savePatch): Promise<SaveOutcome> {
  const w = todoDuePatch(row, due, now, tz);
  return save('todos', row.id, w.data, w.remind);
}
