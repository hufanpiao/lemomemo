// 今天页的 hook（B2 FA-2）：读日程、待办两个集合，按 clock.now() 和 current_tz 算出“现在”卡、没赶上、今天的安排
// • 每分钟刷新一次（“还剩”、此刻竖线；视觉稿“刷新”一条），对齐到整分钟；时间窗随行变化、跨分钟重算
// • 写入（打勾、删除、撤销）经 data/today-actions.ts；没写进去的原因回给界面（提示条），switching 不提示（页面马上跳走）
// • 打勾、删除的写入代码第一次点时才下载（首屏预算 150 KB，b2-first-screen-budget：今天页出现之前用不到它们）
import { useCallback, useMemo, useRef } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { TrashTable } from '../data/today-actions.ts';
import type { doneToggler } from '../../../core/todo-done.ts';
import type { Priority } from '../../../../shared/logic/todo-row.ts';
import { eventsOn, lateTodos, nowCard, nowEvents, todayTodos, tomorrowOf, type Row } from '../data/today-model.ts';

export function useToday() {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const now = useMinuteNow();
  const tz = currentTz();
  const today = todayOf(now, tz);
  // 同一时刻的按标题排，按当前语言、数字按数值（“第 2 条”在“第 10 条”前）
  const locale = useUi((s) => s.locale);

  const model = useMemo(() => {
    const evToday = eventsOn(events, today, tz, locale);
    // 明天开始的第一件（R-444：今天开始、跨进明天的也在明天的清单里，不算）
    const tmr = tomorrowOf(now, tz);
    const tomorrow = eventsOn(events, tmr, tz, locale).filter((o) => !o.allDay && o.date === tmr);
    return {
      today,
      tz,
      now,
      events: evToday,
      // “现在”卡另算一份：昨天没结束的带时刻日程（跨零点）也算进去，明天第一件写在“都结束了”的卡底
      card: nowCard(nowEvents(events, now, tz, locale), now, tz, today, tomorrow[0] ?? null),
      late: lateTodos(todos, now, tz, locale),
      todos: todayTodos(todos, now, tz, locale),
    };
  }, [events, todos, now, tz, today, locale]);

  const rowOf = useCallback((id: string) => todos.find((r) => r.id === id), [todos]);

  // 打勾：刚点过的再点回去按撤销写回原来的 done_at（core/todo-done.ts，评审第 15 条）；这一页挂着期间记着
  const toggler = useRef<ReturnType<typeof doneToggler> | null>(null);
  const toggleDone = useCallback(
    async (id: string, done: boolean): Promise<ActionResult> => {
      const r = rowOf(id);
      if (!r) return 'failed';
      toggler.current ??= (await import('../../../core/todo-done.ts')).doneToggler();
      return actionResult(await toggler.current(r, done, clock.now(), currentTz()));
    },
    [rowOf],
  );

  const remove = useCallback(
    async (table: TrashTable, id: string, deleted: boolean): Promise<ActionResult> => {
      const r = (table === 'todos' ? todos : events).find((x) => x.id === id);
      if (!r) return 'failed';
      const { setDeleted } = await import('../data/today-actions.ts');
      return actionResult(await setDeleted(table, r, deleted, clock.now(), currentTz()));
    },
    [events, todos],
  );

  // 待办行右边 H / M / L 换档（R-434）：写入在 core/todo-priority.ts（和待办页同一份），点了才下载，不进首屏
  const setPriority = useCallback(async (id: string, p: Priority): Promise<ActionResult> => {
    const { setTodoPriority } = await import('../../../core/todo-priority.ts');
    return actionResult(await setTodoPriority(id, p, clock.now()));
  }, []);

  return { ...model, toggleDone, remove, setPriority };
}
