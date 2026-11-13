// 电脑版今天页“本周”块（定稿线框 s1 电脑画面“本周忙闲”，5.9b 的 week 块）：这一周每天有几件事（日程 + 没完成的、那天截止的待办），画成柱子。纯 TS（A1）
// • 一周从周一起（线框画的“一 二 三 …”；B6 代定：不读日历页的“每周第一天”设置，今天页不加载日历设置）
// • 日程按 eventsOn 同一套算法（固定时区换到当前时区、跨天、重复事项 4.0.x 只算第一次）；只读、删除、撤销的不算
import { addDays, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { eventsOn, todoOcc, type Row } from './today-model.ts';

export interface DayBusy {
  date: DateStr;
  n: number;
}

/** 这一周（周一到周日）每天几件事 */
export function weekBusy(events: readonly Row[], todos: readonly Row[], today: DateStr, tz: Tz, locale: Locale): DayBusy[] {
  const mon = addDays(today, -((weekdayOf(today) + 6) % 7));
  const due = new Map<string, number>();
  for (const r of todos) {
    if (!isLiveRow(r)) continue;
    const t = todoOcc(r);
    if (!t.done && t.due) due.set(t.due, (due.get(t.due) ?? 0) + 1);
  }
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(mon, i);
    return { date, n: eventsOn(events, date, tz, locale).length + (due.get(date) ?? 0) };
  });
}
