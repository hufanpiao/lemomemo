// 待办列表页的 hook（B2 FA-2）：分组、项目筛选（只在这一页，不写 settings，架构 5.9）、打勾、删除和撤销
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { setTodoDeleted, setTodoDone, type SaveOutcome } from '../data/todo-actions.ts';
import { groupTodos, projectCounts, type Row } from '../data/todo-list.ts';
import { listKo } from '../i18n/list-ko.ts';
import { listZh } from '../i18n/list-zh.ts';

export type { DueTag, Group, TodoItem } from '../data/todo-list.ts';
export type ListMsgKey = keyof typeof listZh & string;

const tList = createT({ zh: listZh, ko: listKo });

export function useListT() {
  const locale = useUi((s) => s.locale);
  return useCallback(<K extends ListMsgKey>(key: K, params: ParamsOf<typeof listZh, K>): string => tList(key, params, locale), [locale]);
}

export type ActionResult = 'ok' | 'failed' | 'readonly' | 'silent';
const resultOf = (r: SaveOutcome): ActionResult => (r === 'saved' ? 'ok' : r === 'readonly' ? 'readonly' : r === 'switching' ? 'silent' : 'failed');

const MIN = 60_000;

export function useTodoList() {
  const rows = useCollection<Row>('todos');
  const [project, setProject] = useState<string | null>(null);
  const [now, setNow] = useState(() => clock.now());
  // 每分钟重算一次（“已过 17:00”跨分钟出现）
  useEffect(() => {
    const id = setInterval(() => setNow(clock.now()), MIN);
    return () => clearInterval(id);
  }, []);
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
      return resultOf(await setTodoDone(r, done, clock.now(), currentTz()));
    },
    [rows],
  );
  const remove = useCallback(
    async (id: string, deleted: boolean): Promise<ActionResult> => {
      const r = rows.find((x) => x.id === id);
      if (!r) return 'failed';
      return resultOf(await setTodoDeleted(r, deleted, clock.now(), currentTz()));
    },
    [rows],
  );

  return { groups, projects, project: active, setProject, toggleDone, remove, total: rows.length };
}
