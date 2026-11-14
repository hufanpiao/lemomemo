// 待办标完成、改回没完成、撤销：今天页、待办列表、子任务自动完成、查找和结果层（smart-search/data/target-act.ts）、提醒页都调这一份
// （B4b-3 独立评审第 15 条，主持人 11-14 定口径；原来今天页、待办页各一份 setTodoDone，查找、提醒页又各写一遍）：
// • 提醒标记一律按 core/remind-flag.ts 的 todoRemindFlag 算（改之后会响，或改之前还会响），不一律带 true
// • 标完成记 done_at = now；已经完成的再点完成，不覆盖 done_at；改回没完成写 0
// • 撤销写回原来的 done 和原来的 done_at（donePrev 记下的）
// • 列表、今天页：刚点过的那一条再点回去就是撤销（doneToggler，按页记着改之前的值，撤销一次就忘掉）
// 编辑页（todos/data/todo-edit.ts）按表单整行写，不在这里。tests 里有守门：src 里写 done_at 的只有这个文件
import type { Tz } from '../../shared/core/tz.ts';
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

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export function donePrev(row: TodoRow): DonePrev {
  return { done: row['done'] === true, doneAt: num(row['done_at']) ?? 0 };
}

const remindFor = (row: TodoRow, done: boolean, now: number, tz: Tz): boolean =>
  todoRemindFlag({ row, after: todoRemindFields(row, done), prevRemindAt: num(row['remind_at']), now, tz });

/** 改成 done 要写的列和提醒标记（不写库） */
export function todoDonePatch(row: TodoRow, done: boolean, now: number, tz: Tz): TodoWrite {
  const p = donePrev(row);
  const doneAt = !done ? 0 : p.done && p.doneAt > 0 ? p.doneAt : now;
  return { data: { done, done_at: doneAt, updated_at: now }, remind: remindFor(row, done, now, tz) };
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
