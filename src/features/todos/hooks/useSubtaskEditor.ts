// 待办编辑页“子任务”区的 hook（R-350 方案 5.3、5.5、6.1）：把 data/todo-items.ts 的写入接到界面上，界面（ui/SubtaskEditor.tsx）只管画和拖动
// • 加：回车加一项（去掉首尾空白，空的不加）；粘贴多行按行拆，只加到 ITEMS_MAX，多出来的条数记运行日志 todo items cap dropped=N 并出提示
// • 到上限：运行日志记 todo items full（只记事件）；改标题清空了不保存（界面恢复原字）
// • 勾选：主待办跟着改的规则同列表页（autoTodo）；勾上最后一项自动完成时出撤销条（Q1 两件一起撤回），运行日志 todo sub auto done|undone 在 data 层 tickSubtask 里记
// • 提示（同一时间只出一条）：deleted / auto 是 8 秒撤销条；quota、error 是一行红字
import { useEffect, useRef, useState } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import type { SaveOutcome } from '../../../core/edit-save.ts';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import {
  addSubtasks, cleanTitle, ITEMS_MAX, ITEMS_TABLE, moveSubtask, setSubtaskDeleted, setSubtaskTitle, splitLines, tickSubtask, undoAutoDone,
} from '../data/todo-items.ts';
import type { Row } from '../data/todo-list.ts';
import { usePicked, useSubtaskGroups } from './useSubtasks.ts';

export { ITEMS_MAX, TODO_ITEM_TITLE_MAX } from '../data/todo-items.ts';

export type SubtaskToast = { kind: 'deleted' | 'auto'; id: string } | { kind: 'error' } | { kind: 'quota' };

const now = (): number => clock.now();

/**
 * todoId：主待办 id，新建页还没保存时为 null（整块灰掉）；todo：主待办现在的行；off：只读、已删除、找不到（只看不改）
 */
export function useSubtaskEditor(todoId: string | null, todo: Readonly<Record<string, unknown>> | undefined, off: boolean) {
  const items = useSubtaskGroups().get(todoId ?? '') ?? [];
  const ro = useReadonlyIds(ITEMS_TABLE);
  const { shown, pick } = usePicked(items);
  const [toast, setToast] = useState<SubtaskToast | null>(null);
  const todoRef = useRef<Row | undefined>(undefined);
  todoRef.current = typeof todo?.['id'] === 'string' ? (todo as Row) : undefined;
  const blocked = off || todoId === null;
  const full = items.length >= ITEMS_MAX;

  useEffect(() => {
    if (full && !blocked) rlog('todo items full');
  }, [full, blocked]);

  const report = (o: SaveOutcome): void => {
    if (o !== 'saved' && o !== 'switching') setToast({ kind: 'error' });
  };
  const addTitles = (titles: readonly string[], dropped: number): void => {
    if (dropped > 0) {
      rlog(`todo items cap dropped=${dropped}`);
      setToast({ kind: 'quota' });
    }
    if (todoId !== null && titles.length) void addSubtasks(todoId, items, titles, now()).then(report);
  };

  return {
    items,
    shown,
    toast,
    blocked,
    full,
    /** 这一行能不能改（整块能改、这一项不是只读） */
    rowOff: (id: string): boolean => blocked || ro.has(id),
    /** 回车加一项；加了返回 true（界面清空输入框） */
    addOne(text: string): boolean {
      const v = cleanTitle(text);
      if (v === '' || full || blocked) return false;
      addTitles([v], 0);
      return true;
    },
    /** 粘贴：有换行才按行拆着加，返回 true（界面拦下默认粘贴、清空输入框）；单行照常粘进输入框 */
    paste(text: string): boolean {
      if (!/[\r\n]/.test(text) || blocked) return false;
      const r = splitLines(text, ITEMS_MAX - items.length);
      addTitles(r.titles, r.dropped);
      return true;
    },
    rename(id: string, text: string): void {
      const v = cleanTitle(text);
      const cur = items.find((i) => i.id === id);
      if (v !== '' && cur && v !== cur.title && !blocked) void setSubtaskTitle(id, v, now()).then(report);
    },
    remove(id: string): void {
      if (blocked) return;
      void setSubtaskDeleted(id, true, now()).then((o) => (o === 'saved' ? setToast({ kind: 'deleted', id }) : report(o)));
    },
    tick(id: string, on: boolean): void {
      const row = todoRef.current;
      if (!row || blocked || ro.has(id)) return;
      pick(id, on);
      void tickSubtask(row, items, id, on, now(), currentTz()).then(({ out, auto }) => {
        if (out === 'saved' && auto === true) setToast({ kind: 'auto', id });
        else report(out);
      });
    },
    move(from: number, to: number): void {
      if (blocked || from === to || to < 0 || to >= items.length) return;
      void moveSubtask(items, from, to, now()).then(report);
    },
    undo(x: SubtaskToast): void {
      if (x.kind === 'deleted') void setSubtaskDeleted(x.id, false, now()).then(report);
      else if (x.kind === 'auto' && todoRef.current) void undoAutoDone(todoRef.current, x.id, now(), currentTz()).then(report);
    },
    closeToast: (x: SubtaskToast): void => setToast((cur) => (cur === x ? null : cur)),
  };
}
