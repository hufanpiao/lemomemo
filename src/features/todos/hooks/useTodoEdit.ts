// 待办编辑页的 hook（B2 FA-2 第一段）：把 data/todo-edit.ts 的规则接到 kit 的 useEditRecord 上
// 界面每改一个字段调 change(patch)：先过 normalize（截止日期、截止时刻的连带规则），再保存
import { useCallback } from 'react';
import { useEditRecord, type EditRecord } from '../../../kit/hooks/useEditRecord.ts';
import { useTypedTitle } from '../../../kit/hooks/useTypedTitle.ts';
import { emptyForm, formOf, hasRemind, newTodoRow, normalize, patchOf, type TodoForm } from '../data/todo-edit.ts';

export type { TodoForm } from '../data/todo-edit.ts';
export { REMIND_BEFORE_OPTIONS, TITLE_MAX, PROJECT_MAX, NOTE_MAX } from '../data/todo-edit.ts';

const SPEC = {
  table: 'todos',
  formOf,
  emptyForm,
  titleOf: (f: TodoForm) => f.title,
  patchOf,
  newRow: newTodoRow,
  hasRemind,
} as const;

export function useTodoEdit(id: string, onCreated?: (id: string) => void): EditRecord<TodoForm> & { change(p: Partial<TodoForm>): void } {
  const rec = useEditRecord<TodoForm>({ ...SPEC, id, ...(onCreated ? { onCreated } : {}) });
  const { form, update } = rec;
  const change = useCallback(
    (p: Partial<TodoForm>) => {
      const next = normalize(form, { ...form, ...p });
      if (p.title !== undefined) next.title = p.title.trim();
      void update(next);
    },
    [form, update],
  );
  useTypedTitle(id, change);
  return { ...rec, change };
}
