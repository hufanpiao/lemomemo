// 待办列表页的 hook（B2 FA-2）：分组、项目筛选（只在这一页，不写 settings，架构 5.9）、打勾、删除和撤销
// R-350：子任务按主待办分组（subs）；勾子任务（tickSub，主待办跟着改的规则在 data/todo-items.ts 的 autoTodo，planAuto 让页面先知道会不会挪卡片）、
//   撤销“自动完成”（undoAuto，Q1：刚勾的那项和主待办一起撤回）
import { useCallback, useMemo, useState } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { setTodoDeleted, setTodoDone } from '../data/todo-actions.ts';
import { autoTodo, tickSubtask, undoAutoDone } from '../data/todo-items.ts';
import { groupTodos, projectCounts, type Row } from '../data/todo-list.ts';
import { listKo } from '../i18n/list-ko.ts';
import { listZh } from '../i18n/list-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { useSubtaskGroups } from './useSubtasks.ts';

export type { DueTag, Group, TodoItem } from '../data/todo-list.ts';
export type ListMsgKey = keyof typeof listZh & string;

export const useListT = makeUseT({ zh: listZh, ko: listKo });

export function useTodoList() {
  const rows = useCollection<Row>('todos');
  const [project, setProject] = useState<string | null>(null);
  // 每分钟重算一次（“已过 17:00”跨分钟出现）
  const now = useMinuteNow();
  const tz = currentTz();
  // 同一截止时刻、没日期那组按标题排，筛选条条数一样的按项目名排：按当前语言、数字按数值（“第 2 条”在“第 10 条”前）
  const locale = useUi((s) => s.locale);
  const projects = useMemo(() => projectCounts(rows, locale), [rows, locale]);
  // 筛的项目没了（最后一条完成或删掉）：回到“全部”
  const active = project !== null && projects.some((p) => p.project === project) ? project : null;
  const groups = useMemo(() => groupTodos(rows, now, tz, active, locale), [rows, now, tz, active, locale]);

  const toggleDone = useCallback(
    async (id: string, done: boolean): Promise<ActionResult> => {
      const r = rows.find((x) => x.id === id);
      if (!r) return 'failed';
      return actionResult(await setTodoDone(r, done, clock.now(), currentTz()));
    },
    [rows],
  );
  const remove = useCallback(
    async (id: string, deleted: boolean): Promise<ActionResult> => {
      const r = rows.find((x) => x.id === id);
      if (!r) return 'failed';
      return actionResult(await setTodoDeleted(r, deleted, clock.now(), currentTz()));
    },
    [rows],
  );

  const subs = useSubtaskGroups();
  const find = (todoId: string) => ({ r: rows.find((x) => x.id === todoId), items: subs.get(todoId) });
  /** 勾这一项会不会顺带改主待办（true 完成、false 改回未完成、null 不动）：会改的话页面先留住分组 --dur-ui 再挪卡片 */
  const planAuto = (todoId: string, itemId: string, on: boolean): boolean | null => {
    const { r, items } = find(todoId);
    return r && items ? autoTodo(r['done'] === true, items, itemId, on) : null;
  };
  const tickSub = async (todoId: string, itemId: string, on: boolean): Promise<{ res: ActionResult; auto: boolean | null }> => {
    const { r, items } = find(todoId);
    if (!r || !items) return { res: 'failed', auto: null };
    const x = await tickSubtask(r, items, itemId, on, clock.now(), currentTz());
    return { res: actionResult(x.out), auto: x.auto };
  };
  const undoAuto = async (todoId: string, itemId: string): Promise<ActionResult> => {
    const { r } = find(todoId);
    return r ? actionResult(await undoAutoDone(r, itemId, clock.now(), currentTz())) : 'failed';
  };

  const ids = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  return { groups, projects, project: active, setProject, toggleDone, remove, total: rows.length, ids, subs, planAuto, tickSub, undoAuto };
}
