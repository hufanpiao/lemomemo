// Node 和 Deno 结果一字不差（架构 2.5）：同一批输入在两边算出的表必须等于 golden.json
// 时区里特意放了半小时夏令时的 Lord_Howe 和没有夏令时的上海、首尔
import { msAt, minOfDay, todayOf } from '../../shared/core/date.ts';
import { offsetMin } from '../../shared/core/tz.ts';
import { fmtDate } from '../../shared/i18n/fmt.ts';

export const TZS = ['Asia/Seoul', 'Asia/Shanghai', 'America/Los_Angeles', 'Europe/London', 'UTC', 'Australia/Lord_Howe'];
export const DATES = ['2026-01-01', '2026-03-08', '2026-03-29', '2026-04-05', '2026-10-04', '2026-10-25', '2026-11-01'];
export const MINS = [0, 90, 150, 539, 1439];

export type GoldenRow = [tz: string, date: string, min: number, ms: number, off: number, day: string, back: number, zh: string, ko: string];

export function computeGolden(): GoldenRow[] {
  const rows: GoldenRow[] = [];
  for (const tz of TZS) {
    for (const date of DATES) {
      for (const min of MINS) {
        const ms = msAt(date, min, tz);
        rows.push([
          tz,
          date,
          min,
          ms,
          offsetMin(ms, tz),
          todayOf(ms, tz),
          minOfDay(ms, tz),
          fmtDate(ms, tz, 'zh-CN', 'monthDayWeek'),
          fmtDate(ms, tz, 'ko-KR', 'monthDayWeek'),
        ]);
      }
    }
  }
  return rows;
}
