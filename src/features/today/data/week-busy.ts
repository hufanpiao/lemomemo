// 网页版宽屏今天页的周历和“本周”柱体（参考页 .wst .wd、.bc .bi）：这一周每天的日程和几件事。纯 TS
// • 一周从周日起（参考页周历“日 一 二 … 六”；今天页不加载日历页的“每周第一天”设置）
// • 每天几件 = 日程 + 没完成的、那天截止的待办（柱子高度、“本周 N 项”）；日程按 eventsOn 同一套算法（固定时区换到当前时区、跨天、重复事项 4.0.x 只算第一次）；
//   只读、删除、撤销的不算
import { addDays, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { eventsOn, todoOcc, type EventOcc, type Row } from './today-model.ts';

export interface DayBusy {
  date: DateStr;
  /** 这一天几件事（日程 + 没完成的、这天截止的待办） */
  n: number;
  /** 这一天的日程（全天的在前，再按开始先后） */
  events: EventOcc[];
}

/** 这一周（周日到周六）每天的日程和几件事 */
export function weekBusy(events: readonly Row[], todos: readonly Row[], today: DateStr, tz: Tz, locale: Locale): DayBusy[] {
  const sun = addDays(today, -weekdayOf(today));
  const due = new Map<string, number>();
  for (const r of todos) {
    if (!isLiveRow(r)) continue;
    const t = todoOcc(r);
    if (!t.done && t.due) due.set(t.due, (due.get(t.due) ?? 0) + 1);
  }
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(sun, i);
    const evs = eventsOn(events, date, tz, locale);
    return { date, n: evs.length + (due.get(date) ?? 0), events: evs };
  });
}
