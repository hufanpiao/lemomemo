// 待办列表页的 hook（B2 FA-2）：分组、项目筛选（只在这一页，不写 settings，架构 5.9）、打勾、删除和撤销
// R-350：子任务按主待办分组（subs）；勾子任务（tickSub，主待办跟着改的规则在 data/todo-items.ts 的 autoTodo，planAuto 让页面先知道会不会挪卡片）、
//   撤销“自动完成”（undoAuto，Q1：刚勾的那项和主待办一起撤回）
// R-429：长按拖动放下（sortDrop：按页面画着的分组算要写的排序值、截止日期，data/todo-sort.ts）和撤销（sortUndo）
import { useCallback, useMemo, useState } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { setTodoDeleted } from '../data/todo-actions.ts';
import { doneToggler } from '../../../core/todo-done.ts';
import { setTodoPriority } from '../../../core/todo-priority.ts';
import { todayOf } from '../../../../shared/core/date.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import type { Priority } from '../../../../shared/logic/todo-row.ts';
import { autoTodo, tickSubtask, undoAutoDone } from '../data/todo-items.ts';
import { groupTodos, projectCounts, type Group, type Row } from '../data/todo-list.ts';
import { applyTodoSort, planTodoDrop, type TodoSortPlan } from '../data/todo-sort.ts';
import { listKo } from '../i18n/list-ko.ts';
import { listZh } from '../i18n/list-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { useSubtaskGroups } from './useSubtasks.ts';

export type { DueTag, Group, TodoItem } from '../data/todo-list.ts';
export type { TodoSortPlan } from '../data/todo-sort.ts';
export { canDropTodo, groupId } from '../data/todo-sort.ts';
export type ListMsgKey = keyof typeof listZh & string;

export const useListT = makeUseT({ zh: listZh, ko: listKo });

const NONE: ReadonlySet<string> = new Set();

/** linger：刚打勾、先留在原组的那几条（页面的撤销条开着期间；data/todo-list.ts 的 groupTodos）；同一份集合不变时不重算分组，页面要传同一个对象 */
export function useTodoList(linger: ReadonlySet<string> = NONE) {
  const rows = useCollection<Row>('todos');
  const [project, setProject] = useState<string | null>(null);
  // 每分钟重算一次（“已过 17:00”跨分钟出现）
  const now = useMinuteNow();
  const tz = currentTz();
  // 同一截止时刻、没日期那组按标题排，筛选条条数一样的按项目名排：按当前语言、数字按数值（“第 2 条”在“第 10 条”前）
  const locale = useUi((s) => s.locale);
  const projects = useMemo(() => projectCounts(rows, locale), [rows, locale]);
  // 筛的项目没了（这个项目的最后一条删掉、或改了项目；已完成的也算在条数里，完成不会让它消失）：回到“全部”
  const active = project !== null && projects.some((p) => p.project === project) ? project : null;
  const groups = useMemo(() => groupTodos(rows, now, tz, active, locale, linger), [rows, now, tz, active, locale, linger]);
  // 标题下面一行“11月15日 周日 · 1 / 10 完成”（R-436 第 2 条）：按当前筛选数这一页的条数和完成的条数；
  // “全部”胶囊的条数 all = 全部条数，含已完成（确认图“全部 10”和“1 / 10 完成”同一个口径；各项目胶囊同口径，见 projectCounts）
  const count = useMemo(() => {
    const items = groups.flatMap((g) => g.items);
    return { total: items.length, done: items.filter((x) => x.todo.done).length, all: rows.filter(isLiveRow).length };
  }, [groups, rows]);

  // 打勾：刚点过的再点回去按撤销写回原来的 done_at（core/todo-done.ts，评审第 15 条）；这一页挂着期间记着
  const [toggle] = useState(() => doneToggler());
  const toggleDone = useCallback(
    async (id: string, done: boolean): Promise<ActionResult> => {
      const r = rows.find((x) => x.id === id);
      if (!r) return 'failed';
      return actionResult(await toggle(r, done, clock.now(), currentTz()));
    },
    [rows, toggle],
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

  /** 行右边 H / M / L 点一下换档（R-434，core/todo-priority.ts，今天页同一份） */
  const setPriority = async (id: string, p: Priority): Promise<ActionResult> => actionResult(await setTodoPriority(id, p, clock.now()));

  /** 拖动放下（R-429）：view 是页面此刻画着的分组（留在原位的已完成也在里面，下标才对得上）；对不上回 null（什么都不写） */
  const sortDrop = async (view: readonly Group[], d: { id: string; from: string; to: string; index: number }): Promise<{ res: ActionResult; plan: TodoSortPlan } | null> => {
    const t = clock.now();
    const z = currentTz();
    const plan = planTodoDrop(view, rows, d, t, z, todayOf(t, z));
    if (!plan || plan.writes.length === 0) return null;
    return { res: actionResult(await applyTodoSort(plan.writes, rows, false, t, z)), plan };
  };
  const sortUndo = async (plan: TodoSortPlan): Promise<ActionResult> => actionResult(await applyTodoSort(plan.writes, rows, true, clock.now(), currentTz()));

  const ids = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  return { today: todayOf(now, tz), count, setPriority, sortDrop, sortUndo, groups, projects, project: active, setProject, toggleDone, remove, ids, subs, planAuto, tickSub, undoAuto };
}
