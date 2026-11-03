// 今天页的 hook（B2 FA-2）：读日程、待办两个集合，按 clock.now() 和 current_tz 算出“现在”卡、没赶上、今天的安排
// • 每分钟刷新一次（“还剩”、此刻竖线；视觉稿“刷新”一条），对齐到整分钟；时间窗随行变化、跨分钟重算
// • 写入（打勾、删除、撤销）经 data/today-actions.ts；没写进去的原因回给界面（提示条），switching 不提示（页面马上跳走）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { clock } from '../../../platform/clock.ts';
import { setDeleted, setTodoDone, type SaveOutcome, type TrashTable } from '../data/today-actions.ts';
import { eventsOn, lateTodos, nowCard, todayTodos, tomorrowOf, type Row } from '../data/today-model.ts';

const MIN = 60_000;

/** 每分钟变一次的 now（对齐整分钟）；测试里 spyOn clock.now 就能固定 */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const n = clock.now();
      setNow(n);
      t = setTimeout(tick, MIN - (n % MIN) + 50);
    };
    t = setTimeout(tick, MIN - (clock.now() % MIN) + 50);
    return () => clearTimeout(t);
  }, []);
  return now;
}

export type ActionResult = 'ok' | 'failed' | 'readonly' | 'silent';

const resultOf = (r: SaveOutcome): ActionResult => (r === 'saved' ? 'ok' : r === 'readonly' ? 'readonly' : r === 'switching' ? 'silent' : 'failed');

export function useToday() {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const now = useMinuteNow();
  const tz = currentTz();
  const today = todayOf(now, tz);

  const model = useMemo(() => {
    const evToday = eventsOn(events, today, tz);
    const tomorrow = eventsOn(events, tomorrowOf(now, tz), tz).filter((o) => !o.allDay);
    return {
      today,
      tz,
      now,
      events: evToday,
      card: nowCard(evToday, now, tz, today),
      tomorrowFirst: tomorrow[0] ?? null,
      late: lateTodos(todos, now, tz),
      todos: todayTodos(todos, now, tz),
    };
  }, [events, todos, now, tz, today]);

  const rowOf = useCallback((id: string) => todos.find((r) => r.id === id), [todos]);

  const toggleDone = useCallback(
    async (id: string, done: boolean): Promise<ActionResult> => {
      const r = rowOf(id);
      if (!r) return 'failed';
      return resultOf(await setTodoDone(r, done, clock.now(), currentTz()));
    },
    [rowOf],
  );

  const remove = useCallback(
    async (table: TrashTable, id: string, deleted: boolean): Promise<ActionResult> => {
      const r = (table === 'todos' ? todos : events).find((x) => x.id === id);
      if (!r) return 'failed';
      return resultOf(await setDeleted(table, r, deleted, clock.now(), currentTz()));
    },
    [events, todos],
  );

  return { ...model, toggleDone, remove };
}
