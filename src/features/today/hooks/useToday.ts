// 今天页的 hook（B2 FA-2）：读日程、待办两个集合，按 clock.now() 和 current_tz 算出“现在”卡、没赶上、今天的安排
// • 每分钟刷新一次（“还剩”、此刻竖线；视觉稿“刷新”一条），对齐到整分钟；时间窗随行变化、跨分钟重算
// • 写入（打勾、删除、撤销）经 data/today-actions.ts；没写进去的原因回给界面（提示条），switching 不提示（页面马上跳走）
import { useCallback, useMemo } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { actionResult, type ActionResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { setDeleted, setTodoDone, type TrashTable } from '../data/today-actions.ts';
import { eventsOn, lateTodos, nowCard, todayTodos, tomorrowOf, type Row } from '../data/today-model.ts';

export type { ActionResult };

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
    const tomorrow = eventsOn(events, tomorrowOf(now, tz), tz, locale).filter((o) => !o.allDay);
    return {
      today,
      tz,
      now,
      events: evToday,
      card: nowCard(evToday, now, tz, today),
      tomorrowFirst: tomorrow[0] ?? null,
      late: lateTodos(todos, now, tz, locale),
      todos: todayTodos(todos, now, tz, locale),
    };
  }, [events, todos, now, tz, today, locale]);

  const rowOf = useCallback((id: string) => todos.find((r) => r.id === id), [todos]);

  const toggleDone = useCallback(
    async (id: string, done: boolean): Promise<ActionResult> => {
      const r = rowOf(id);
      if (!r) return 'failed';
      return actionResult(await setTodoDone(r, done, clock.now(), currentTz()));
    },
    [rowOf],
  );

  const remove = useCallback(
    async (table: TrashTable, id: string, deleted: boolean): Promise<ActionResult> => {
      const r = (table === 'todos' ? todos : events).find((x) => x.id === id);
      if (!r) return 'failed';
      return actionResult(await setDeleted(table, r, deleted, clock.now(), currentTz()));
    },
    [events, todos],
  );

  return { ...model, toggleDone, remove };
}
