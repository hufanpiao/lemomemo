// 月历、周视图测试共用：造日程、待办行（只填月历用到的列）
import type { CalEvent, CalTodo } from '../../../shared/logic/calendar/cal-items.ts';

export function ev(p: Partial<CalEvent> & Pick<CalEvent, 'id' | 'date'>): CalEvent {
  return {
    title: `event ${p.id}`,
    short: null,
    project: '',
    time: null,
    tz: null,
    duration_min: 60,
    created_at: 1,
    deleted_at: null,
    ...p,
  };
}

export function todo(p: Partial<CalTodo> & Pick<CalTodo, 'id'>): CalTodo {
  return {
    title: `todo ${p.id}`,
    short: null,
    project: '',
    due: null,
    done: false,
    created_at: 1,
    deleted_at: null,
    ...p,
  };
}

/** 有时刻的日程（固定时刻，带记录时的时区） */
export function timed(id: string, date: string, time: string, tz: string, duration = 60, extra: Partial<CalEvent> = {}): CalEvent {
  return ev({ id, date, time, tz, duration_min: duration, ...extra });
}
