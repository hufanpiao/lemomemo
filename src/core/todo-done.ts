// 待办的完成状态（done、done_at）只在这里定规则（B4b-3 独立评审第 15 条，主持人 11-14 定口径；审查 11-15 第 7 条把编辑页那一份也并进来）：
// • 打勾、取消打勾、撤销的写入：今天页、待办列表、子任务自动完成（features/todos/data/todo-items.ts）、查找和结果层（smart-search/data/target-act.ts）、
//   提醒页都调这里的 setTodoDone / undoTodoDone / doneToggler（原来今天页、待办页各一份 setTodoDone，查找、提醒页又各写一遍）
// • done_at 怎么算（doneAtOf，只有这一份）：标完成记 now；这一行本来就是完成的，不覆盖原来的 done_at；改回没完成写 0。
//   编辑页（features/todos/data/todo-edit.ts 的 patchOf）按表单整行写，改了“完成”那一格时 done_at 也调 doneAtOf
// • 提醒标记一律按 core/remind-flag.ts 的 todoRemindFlag 算（改之后会响，或改之前还会响），不一律带 true；编辑页的提醒标记另由编辑页按整份表单算
// • 撤销写回原来的 done 和原来的 done_at（donePrev 记下的）
// • 列表、今天页：刚点过的那一条再点回去就是撤销（doneToggler，按页记着改之前的值，撤销一次就忘掉）
// tests 里有守门：src 里写 done_at 列的只有这个文件（编辑页按表单写 data["done_at"]，值也取 doneAtOf）
import type { Tz } from '../../shared/core/tz.ts';
import { numOr } from '../../shared/logic/todo-row.ts';
import { savePatch, type SaveOutcome } from './edit-save.ts';
import { todoRemindFields, todoRemindFlag } from './remind-flag.ts';

export type TodoRow = Readonly<Record<string, unknown>> & { readonly id: string };
/** 改之前的完成状态（撤销写回用） */
export interface DonePrev {
  done: boolean;
  doneAt: number;
}
export interface TodoWrite {
  data: { done: boolean; done_at: number; updated_at: number };
  remind: boolean;
}
type Save = (table: string, id: string, data: Record<string, unknown>, remind: boolean) => Promise<SaveOutcome>;

export function donePrev(row: Readonly<Record<string, unknown>>): DonePrev {
  return { done: row['done'] === true, doneAt: numOr(row['done_at'], 0) };
}

const remindFor = (row: TodoRow, done: boolean, now: number, tz: Tz): boolean =>
  todoRemindFlag({ row, after: todoRemindFields(row, done), prevRemindAt: numOr(row['remind_at'], null), now, tz });

/** 改成 done 以后的 done_at（规则见文件头；row 是改之前的行） */
export function doneAtOf(row: Readonly<Record<string, unknown>>, done: boolean, now: number): number {
  const p = donePrev(row);
  return !done ? 0 : p.done && p.doneAt > 0 ? p.doneAt : now;
}

/** 改成 done 要写的列和提醒标记（不写库） */
export function todoDonePatch(row: TodoRow, done: boolean, now: number, tz: Tz): TodoWrite {
  return { data: { done, done_at: doneAtOf(row, done, now), updated_at: now }, remind: remindFor(row, done, now, tz) };
}

/** 撤销：row 是现在的行（已经改过），写回 prev */
export function todoUndoPatch(row: TodoRow, prev: DonePrev, now: number, tz: Tz): TodoWrite {
  return { data: { done: prev.done, done_at: prev.doneAt, updated_at: now }, remind: remindFor(row, prev.done, now, tz) };
}

export function setTodoDone(row: TodoRow, done: boolean, now: number, tz: Tz, save: Save = savePatch): Promise<SaveOutcome> {
  const w = todoDonePatch(row, done, now, tz);
  return save('todos', row.id, w.data, w.remind);
}

export function undoTodoDone(row: TodoRow, prev: DonePrev, now: number, tz: Tz, save: Save = savePatch): Promise<SaveOutcome> {
  const w = todoUndoPatch(row, prev, now, tz);
  return save('todos', row.id, w.data, w.remind);
}

/** 列表、今天页的打勾：同一条刚改过、这次改回原来的状态，就按撤销写回原值；只记写成功的 */
export function doneToggler(save: Save = savePatch): (row: TodoRow, done: boolean, now: number, tz: Tz) => Promise<SaveOutcome> {
  const memo = new Map<string, DonePrev>();
  return async (row, done, now, tz) => {
    const prev = memo.get(row.id);
    if (prev && prev.done === done) {
      const out = await undoTodoDone(row, prev, now, tz, save);
      if (out === 'saved') memo.delete(row.id);
      return out;
    }
    const before = donePrev(row);
    const out = await setTodoDone(row, done, now, tz, save);
    if (out === 'saved' && before.done !== done) memo.set(row.id, before);
    return out;
  };
}
