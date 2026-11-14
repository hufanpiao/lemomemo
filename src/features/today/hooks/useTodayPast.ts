// 今天页“已过去”折成一行（定稿线框 s1，B6 对齐线框）：按界面留住的那一份列表（useHoldView 的 view）拆出已过去的，所以不放进 useToday 的 model
import { useMemo } from 'react';
import { splitPast, type EventOcc, type TodoOcc } from '../data/today-model.ts';

export function useTodayPast<E extends Pick<EventOcc, 'end'>, T extends Pick<TodoOcc, 'done'>>(events: readonly E[], todos: readonly T[], now: number) {
  return useMemo(() => splitPast(events, todos, now), [events, todos, now]);
}
