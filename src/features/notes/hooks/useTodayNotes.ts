// 电脑版今天页“今天记的”块的数据（B6，5.9b；ui/TodayNotes.tsx 用）：今天（当前时区）记的随手记，新的在前，最多 max 条
import { useMemo } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { noteItems, type NoteItem, type Row } from '../data/note-list.ts';

export function useTodayNotes(max: number): { items: NoteItem[]; tz: string } {
  const rows = useCollection<Row>('notes');
  const cats = useCollection<Row>('categories');
  const tz = currentTz();
  const today = todayOf(useMinuteNow(), tz);
  const items = useMemo(() => noteItems(rows, cats, tz).filter((it) => it.date === today).slice(0, max), [rows, cats, tz, today, max]);
  return { items, tz };
}
