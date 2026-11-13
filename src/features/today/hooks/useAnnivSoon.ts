// 今天页顶部的纪念日一行（B5 S14）：7 天内最近的一个（data/anniv-soon.ts），纪念日开关关着、一条都没有时为 null。只有 AnnivLine 用（懒加载块里，不进首屏）
import type { DateStr } from '../../../../shared/core/date.ts';
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { annivSoon, type AnnivSoon } from '../data/anniv-soon.ts';

export type { AnnivSoon };

export function useAnnivSoon(today: DateStr): AnnivSoon | null {
  const rows = useCollection<{ id: string }>('anniversaries');
  return rows.length && annivOn() ? annivSoon(rows, today) : null;
}
