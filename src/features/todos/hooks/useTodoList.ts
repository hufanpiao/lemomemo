// 待办列表页的 hook（B2 FA-2）：分组、项目筛选（只在这一页，不写 settings，架构 5.9）、打勾、删除和撤销
// R-350：子任务按主待办分组（subs，页面据此给有子任务的行加样式）；勾子任务、撤销“自动完成”在 ui/InlineSubtasks.tsx（经 useSubtasks.ts 的 subtaskOps，三页同一份）
// R-442：待办页不再长按拖动（R-429 的待办部分作废），组内只按优先级排（data/todo-list.ts）
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
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { compareTodos, todoOf, type Priority } from '../../../../shared/logic/todo-row.ts';
import { groupTodos, projectCounts, type Row } from '../data/todo-list.ts';
import { listKo } from '../i18n/list-ko.ts';
import { listZh } from '../i18n/list-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { useSubtaskGroups } from './useSubtasks.ts';

export type { DueTag, Group, TodoItem } from '../data/todo-list.ts';
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
  // 筛选条条数一样的按项目名排：按当前语言、数字按数值（“第 2 条”在“第 10 条”前）
  const locale = useUi((s) => s.locale);
  const projects = useMemo(() => projectCounts(rows, locale), [rows, locale]);
  // 筛的项目没了（这个项目的最后一条删掉、或改了项目；已完成的也算在条数里，完成不会让它消失）：回到“全部”
  const active = project !== null && projects.some((p) => p.project === project) ? project : null;
  const groups = useMemo(() => groupTodos(rows, now, tz, active, linger), [rows, now, tz, active, linger]);
  // 标题下面一行“11月15日 周日 · 1 / 10 完成”（R-436 第 2 条）：按当前筛选数这一页的条数和完成的条数；
  // “全部”胶囊的条数 all = 全部条数，含已完成（确认图“全部 10”和“1 / 10 完成”同一个口径；各项目胶囊同口径，见 projectCounts）
  const count = useMemo(() => {
    const items = groups.flatMap((g) => g.items);
    return { total: items.length, done: items.filter((x) => x.todo.done).length, all: rows.filter(isLiveRow).length };
  }, [groups, rows]);

  const { toggleDone, remove, setPriority } = useTodoWrites(rows);
  const subs = useSubtaskGroups();

  const ids = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  return { today: todayOf(now, tz), count, setPriority, groups, projects, project: active, setProject, toggleDone, remove, ids, subs };
}

/** 日历日清单的待办组（R-443，ui/DayTodos.tsx）：截止日是这一天、没删、没完成的待办（同月历的 todoDate），完成了还留在原位的（linger）照列；
 *  组内按 compareTodos（R-442）；带上打勾、删除的写入 */
export function useDayTodos(date: DateStr, linger: ReadonlySet<string>) {
  const rows = useCollection<Row>('todos');
  const todos = useMemo(
    () => rows.filter(isLiveRow).map(todoOf).filter((x) => x.due === date && (!x.done || linger.has(x.id))).sort(compareTodos),
    [rows, date, linger],
  );
  return { todos, ...useTodoWrites(rows) };
}

/** 打勾、删除、换优先级的写入（待办页、日历日清单的待办组共用，R-443）：打勾时刚点过的再点回去按撤销写回原来的 done_at（core/todo-done.ts，评审第 15 条），挂着期间记着 */
export function useTodoWrites(rows: readonly Row[]) {
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
  /** 行右边 H / M / L 换档（R-434，core/todo-priority.ts，今天页同一份；点哪格设哪档在 kit PrioCycle） */
  const setPriority = async (id: string, p: Priority): Promise<ActionResult> => actionResult(await setTodoPriority(id, p, clock.now()));
  return { toggleDone, remove, setPriority };
}
