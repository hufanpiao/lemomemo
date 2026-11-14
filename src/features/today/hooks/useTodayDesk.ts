// 电脑版今天页“本周”“快到了”两块的数据、日期后面的农历（B6，5.9b；ui/TodayDesk.tsx 用，跟着它按需下载）：读集合、交给 data 层的纯函数算
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { annivLib } from '../../../core/anniv-lib.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useAnnivLib } from '../../../kit/hooks/useAnnivLib.ts';
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { annivUpcoming, nameOf, type AnnivSoon } from '../data/anniv-soon.ts';
import type { Row } from '../data/today-model.ts';
import { weekBusy, type DayBusy } from '../data/week-busy.ts';
import { useLocale } from './useTodayT.ts';

export type { AnnivSoon, DayBusy };
export { nameOf as annivName };

/** 今天的农历（“九月十五”）：中文界面才算（同月历，韩文界面不加载农历）；农历表按需加载（core/anniv-lib.ts），没好、失败、超出表的范围时 null */
export function useLunarToday(today: DateStr): string | null {
  const locale = useLocale();
  const zh = locale !== 'ko-KR';
  if (useAnnivLib(zh) !== 'ready') return null;
  const l = annivLib().toLunar(today, 'cn');
  return l ? annivLib().lunarText(l, locale) : null;
}

/** 这一周（周一到周日）每天几件事 */
export function useWeekBusy(today: DateStr): DayBusy[] {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const locale = useLocale();
  const tz = currentTz();
  return useMemo(() => weekBusy(events, todos, today, tz, locale), [events, todos, today, tz, locale]);
}

/** within 天内的纪念日，最多 max 个；纪念日开关关着时没有 */
export function useAnnivUpcoming(today: DateStr, within: number, max: number): AnnivSoon[] {
  const rows = useCollection<{ id: string }>('anniversaries');
  const on = annivOn();
  return useMemo(() => (on ? annivUpcoming(rows, today, within, max) : []), [on, rows, today, within, max]);
}
