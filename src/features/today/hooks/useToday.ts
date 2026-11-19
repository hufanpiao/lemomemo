// 今天页的 hook（B2 FA-2）：读日程、待办两个集合，按 clock.now() 和 current_tz 算出“现在”卡、没赶上、今天的安排
// • 每分钟刷新一次（“还剩”、此刻竖线；视觉稿“刷新”一条），对齐到整分钟；时间窗随行变化、跨分钟重算
// • 待办行的写入（打勾、删除、撤销、换优先级）和待办页、日历日清单同一份：kit/hooks/useTodoWrites.ts（点了才下载，不进首屏）
import { useMemo } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useTodoWrites } from '../../../kit/hooks/useTodoWrites.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { subProgress } from '../../../../shared/logic/todo-row.ts';
import { eventsOn, lateTodos, nowCard, nowEvents, todayTodos, tomorrowOf, type Row } from '../data/today-model.ts';

/** linger：刚勾完、还留在原位的待办（kit/components/useDoneFlow.ts 的 useLinger），收起以前照没完成排在原来的位置 */
export function useToday(linger: ReadonlySet<string>) {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const items = useCollection<Row>('todo_items');
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
      // 待办之间按 H → M → L（R-442，和待办页同一个 compareTodos）；日程照旧按时刻
      late: lateTodos(todos, now, tz, linger),
      todos: todayTodos(todos, now, tz, linger),
      // 每条待办的子任务做了几项（方框进度、副行“大半 3/4”；今天页引不到待办那一包，计数在 shared/logic/todo-row.ts）
      subs: subProgress(items),
    };
  }, [events, todos, items, now, tz, today, locale, linger]);

  return { ...model, writes: useTodoWrites(todos) };
}
