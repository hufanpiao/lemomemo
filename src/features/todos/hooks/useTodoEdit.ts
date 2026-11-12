// 待办编辑页的 hook（B2 FA-2 第一段）：把 data/todo-edit.ts 的规则接到 kit 的 useEditRecord 上
// 界面每改一个字段调 change(patch)：先过 normalize（截止日期、截止时刻的连带规则；R-375 没截止时改提醒自动填今天，今天按 current_tz，和 remindPassed 同口径），再保存
import { useCallback } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { useEditRecord, type EditRecord } from '../../../kit/hooks/useEditRecord.ts';
import { useTypedTitle } from '../../../kit/hooks/useTypedTitle.ts';
import { emptyForm, formOf, hasRemind, newTodoRow, normalize, patchOf, remindPassed, type TodoForm } from '../data/todo-edit.ts';

export type { TodoForm } from '../data/todo-edit.ts';
export { REMIND_BEFORE_OPTIONS, ITEM_TITLE_MAX, PROJECT_MAX, NOTE_MAX } from '../data/todo-edit.ts';

const SPEC = {
  table: 'todos',
  formOf,
  emptyForm,
  titleOf: (f: TodoForm) => f.title,
  patchOf,
  newRow: newTodoRow,
  hasRemind,
} as const;

/** remindPassed：“当天 / 前一天 + 时刻”的提醒时刻已经过了（R-375，编辑页出灰字；按 current_tz 算，和真正提醒同一份），每次重画现算 */
export function useTodoEdit(id: string, onCreated?: (id: string) => void): EditRecord<TodoForm> & { change(p: Partial<TodoForm>): void; remindPassed: boolean } {
  const rec = useEditRecord<TodoForm>({ ...SPEC, id, ...(onCreated ? { onCreated } : {}) });
  const { form, update } = rec;
  const change = useCallback(
    (p: Partial<TodoForm>) => {
      const next = normalize(form, { ...form, ...p }, todayOf(clock.now(), currentTz()));
      if (p.title !== undefined) next.title = p.title.trim();
      void update(next);
    },
    [form, update],
  );
  useTypedTitle(id, change);
  return { ...rec, change, remindPassed: remindPassed(form, currentTz(), clock.now()) };
}
