// 电脑版今天页“本周”块的数据、日期后面的农历（B6，5.9b；ui/TodayDesk.tsx 用，跟着它按需下载）：读集合、交给 data 层的纯函数算
// （“快到了”块和手机纪念日一行共用 ./useAnnivUpcoming.ts）
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { annivLib } from '../../../core/anniv-lib.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useAnnivLib } from '../../../kit/hooks/useAnnivLib.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import type { Row } from '../data/today-model.ts';
import { weekBusy, type DayBusy } from '../data/week-busy.ts';
import { useLocale } from './useTodayT.ts';

export type { DayBusy };

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
