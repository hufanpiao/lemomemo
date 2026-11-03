// “最近删除”页的 hook（B2 FA-2；ADR-006；TC-B2-03 前两步）：日程、待办里删了不到 30 天的，最近删的在前；恢复 = deleted_at 改回 null
// 永久删除、全部清空（purge_deleted，要联网）在 B4（0.29 续第 121 条⑧），这里不做
import { useCallback, useMemo } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { clock } from '../../../platform/clock.ts';
import { setDeleted, trashOf, type SaveOutcome, type TrashTable } from '../data/today-actions.ts';
import type { Row } from '../data/today-model.ts';
import { useMinuteNow } from './useToday.ts';

export type RestoreResult = 'ok' | 'failed' | 'readonly' | 'silent';
const resultOf = (r: SaveOutcome): RestoreResult => (r === 'saved' ? 'ok' : r === 'readonly' ? 'readonly' : r === 'switching' ? 'silent' : 'failed');

export function useTrash() {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const now = useMinuteNow();
  const items = useMemo(() => trashOf(events, todos, now), [events, todos, now]);
  const restore = useCallback(
    async (table: TrashTable, id: string): Promise<RestoreResult> => {
      const r = (table === 'todos' ? todos : events).find((x) => x.id === id);
      if (!r) return 'failed';
      return resultOf(await setDeleted(table, r, false, clock.now(), currentTz()));
    },
    [events, todos],
  );
  return { items, restore };
}
