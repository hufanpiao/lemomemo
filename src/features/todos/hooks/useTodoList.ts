// 待办列表页的 hook：分组、项目筛选（只在这一页，不写 settings）、打勾、删除和撤销
// 每条待办的子任务做了几项（subs，页面据此画方框进度、副行“大半 3/4”、挂子任务卡片）；勾子任务、撤销“自动完成”在 ui/InlineSubtasks.tsx（经 useSubtasks.ts 的 subtaskOps，三页同一份）
// 待办页不能长按拖动，组内只按优先级排（data/todo-list.ts）
import { useMemo, useState } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useTodoWrites } from '../../../kit/hooks/useTodoWrites.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { compareTodos, isLate, lingerView, todoOf, type TodoFields } from '../../../../shared/logic/todo-row.ts';
import { isOpenTodo } from '../../../../shared/logic/todo-projects.ts';
import { groupTodos, projectCounts, type Row } from '../data/todo-list.ts';
import { listKo } from '../i18n/list-ko.ts';
import { listZh } from '../i18n/list-zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { useSubProgress } from './useSubtasks.ts';

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
  const projects = useMemo(() => projectCounts(rows, locale, linger), [rows, locale, linger]);
  // 筛的项目没了（这个项目的最后一条删掉、改了项目，或全部勾完、收起以后）：回到“全部”
  const active = project !== null && projects.some((p) => p.project === project) ? project : null;
  const groups = useMemo(() => groupTodos(rows, now, tz, active, linger), [rows, now, tz, active, linger]);
  // 标题下面一行“11月15日 周日 · 1 / 10 完成”：按当前筛选数这一页的条数和完成的条数；
  // “全部”胶囊的条数 all 只数没做完的（各项目胶囊同口径，见 projectCounts）
  const count = useMemo(() => {
    const items = groups.flatMap((g) => g.items);
    return { total: items.length, done: items.filter((x) => x.todo.done).length, all: rows.filter((r) => isOpenTodo(r, linger)).length };
  }, [groups, rows, linger]);

  const { toggleDone, remove, setPriority, postpone } = useTodoWrites(rows);
  const subs = useSubProgress();

  const ids = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  return { today: todayOf(now, tz), count, setPriority, postpone, groups, projects, project: active, setProject, toggleDone, remove, ids, subs };
}

/** 日历日清单的待办组（ui/DayTodos.tsx）：截止日是这一天、没删、没完成的待办（同月历的 todoDate），完成了还留在原位的照列（lingerView，三页同一个口径）；
 *  组内按 compareTodos；带上打勾、删除的写入（kit/hooks/useTodoWrites.ts，三页同一份） */
export function useDayTodos(date: DateStr, linger: ReadonlySet<string>) {
  const rows = useCollection<Row>('todos');
  const todos = useMemo(
    () => rows.filter(isLiveRow).map(todoOf).filter((x) => x.due === date && !lingerView(x, linger).done).sort(compareTodos),
    [rows, date, linger],
  );
  // 过了截止的红字：和待办页同一个 isLate、同一个时钟和时区（每分钟一次、current_tz）
  const now = useMinuteNow();
  const late = (t: TodoFields, checked: boolean): boolean => isLate({ ...t, done: checked }, now, currentTz());
  return { todos, late, ...useTodoWrites(rows) };
}

