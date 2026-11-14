// 今天页的纪念日（B5 S14 手机纪念日一行、B6 电脑“快到了”块共用这一个 hook）：within 天内的，最多 max 个（data/anniv-soon.ts），纪念日开关关着时没有。
// 手机那一行在懒加载的 AnnivLine 里用（不进首屏）；显示的名字、还有几天也从这里转给 ui（ui 不直接碰 data）
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { annivUpcoming, type AnnivSoon } from '../data/anniv-soon.ts';

export { ANNIV_SOON_DAYS, annivLabel, annivWhen, nameOf, type AnnivSoon } from '../data/anniv-soon.ts';

export function useAnnivUpcoming(today: DateStr, within: number, max: number): AnnivSoon[] {
  const rows = useCollection<{ id: string }>('anniversaries');
  const on = annivOn();
  return useMemo(() => (on ? annivUpcoming(rows, today, within, max) : []), [on, rows, today, within, max]);
}
