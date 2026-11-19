// 待办行的写入：打勾、删除 / 撤销删除、换优先级。今天页、待办页、日历日清单的待办组共用这一份（独立评审 11-18 二-1：原来 today/hooks/useToday.ts、
// todos/hooks/useTodoList.ts 各写一份）；页面把它交给 kit/components/useTodoRows.ts（useListActions）
// • 打勾：刚点过的再点回去按撤销写回原来的 done_at（core/todo-done.ts 的 doneToggler，评审第 15 条），这一页挂着期间记着
// • 删除：软删、remind 标记；换优先级：R-434，点哪格设哪档在 kit PrioCycle
// • 写入代码第一次点时才下载（今天页首屏预算 150 KB，b2-first-screen-budget：页面出现之前用不到）：三样都从 core/todo-writes.ts 一个入口拿，只一个 import()
// • 没写进去的原因回给界面（core/action-result.ts，提示条）；找不到这一行（刚被别处删了）按 failed
import { useCallback, useRef } from 'react';
import type { Priority } from '../../../shared/logic/todo-row.ts';
import { actionResult, type ActionResult } from '../../core/action-result.ts';
import { currentTz } from '../../core/current-tz.ts';
import type { doneToggler, TodoRow } from '../../core/todo-done.ts';
import { clock } from '../../platform/clock.ts';

const ops = () => import('../../core/todo-writes.ts');

export function useTodoWrites(rows: readonly TodoRow[]) {
  const toggler = useRef<ReturnType<typeof doneToggler> | null>(null);
  const toggleDone = useCallback(
    async (id: string, done: boolean): Promise<ActionResult> => {
      const r = rows.find((x) => x.id === id);
      if (!r) return 'failed';
      toggler.current ??= (await ops()).doneToggler();
      return actionResult(await toggler.current(r, done, clock.now(), currentTz()));
    },
    [rows],
  );
  const remove = useCallback(
    async (id: string, deleted: boolean): Promise<ActionResult> => {
      const r = rows.find((x) => x.id === id);
      if (!r) return 'failed';
      return actionResult(await (await ops()).setTodoDeleted(r, deleted, clock.now(), currentTz()));
    },
    [rows],
  );
  const setPriority = useCallback(async (id: string, p: Priority): Promise<ActionResult> => actionResult(await (await ops()).setTodoPriority(id, p, clock.now())), []);
  return { toggleDone, remove, setPriority };
}
