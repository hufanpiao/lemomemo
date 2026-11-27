// 今天页没日程时的组合区（定稿 方案4.html 的组合区）要的两样数：
// • quickTodo：“今天空着，要不要把它做了？”那一件——没完成、没定日期的待办里排第一的（和待办页同一个 compareTodos：H → M → L、再按创建时间），
//   跳过只读行（要新版本才能改的，“放进今天”写不进去）；ago 是几天前记的（按 current_tz 的日子算）
// • weekDone：“这周做完 N 件 / 比上周 +N / 七根小柱”——一周从周日起（和定稿图写的周一起不同，以周日起为准），
//   柱子顺序 日 一 二 三 四 五 六；按完成时刻 done_at 落在 current_tz 的哪一天数；上周同样周日到周六
// 纯函数，界面在 ui/TodayFun.tsx（按需下载，不进首屏）
import { addDays, diffDays, todayOf, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { numOr } from '../../../../shared/core/field.ts';
import { compareTodos, todoOf, type TodoFields } from '../../../../shared/logic/todo-row.ts';

type Row = Readonly<{ id: string } & Record<string, unknown>>;

export interface QuickTodo {
  todo: TodoFields;
  /** 几天前记的：0 = 今天 */
  ago: number;
}

/** 没完成、没定日期的待办里排第一的一件；ro 里的（只读行）跳过；没有回 null */
export function quickTodo(rows: readonly Row[], today: DateStr, tz: Tz, ro: ReadonlySet<string>): QuickTodo | null {
  let best: TodoFields | null = null;
  for (const r of rows) {
    if (!isLiveRow(r) || ro.has(r.id)) continue;
    const t = todoOf(r);
    if (t.done || t.due !== null || !t.title) continue;
    if (best === null || compareTodos(t, best) < 0) best = t;
  }
  if (best === null) return null;
  return { todo: best, ago: best.createdAt > 0 ? Math.max(0, diffDays(todayOf(best.createdAt, tz), today)) : 0 };
}

export interface WeekDone {
  /** 日 一 二 三 四 五 六 每天做完几件 */
  bars: number[];
  /** 这周（周日起）做完几件 */
  n: number;
  /** 比上周多几件（可以是负数、0） */
  diff: number;
  /** 今天是第几根（0 = 周日） */
  todayIdx: number;
}

/** 这周、上周（都从周日起）做完的待办：删掉的不算，已完成的按 done_at 落在哪一天 */
export function weekDone(rows: readonly Row[], today: DateStr, tz: Tz): WeekDone {
  const todayIdx = weekdayOf(today);
  const start = addDays(today, -todayIdx);
  const bars = [0, 0, 0, 0, 0, 0, 0];
  let prev = 0;
  for (const r of rows) {
    if (!isLiveRow(r) || r['done'] !== true) continue;
    const at = numOr(r['done_at'], 0);
    if (at <= 0) continue;
    const i = diffDays(start, todayOf(at, tz));
    if (i >= 0 && i < 7) bars[i] = (bars[i] ?? 0) + 1;
    else if (i >= -7 && i < 0) prev++;
  }
  const n = bars.reduce((a, b) => a + b, 0);
  return { bars, n, diff: n - prev, todayIdx };
}

/** 小柱高度（px，柱区 30 高）：定稿 bars7() 是 6 + 件数 × 8（最多 3 件正好 30）；一天超过 3 件时按这周最多的那天压到 30，没有的是一截 4px 灰 */
export function barHeight(n: number, max: number): number {
  return n > 0 ? 6 + (24 * n) / Math.max(max, 3) : 4;
}
