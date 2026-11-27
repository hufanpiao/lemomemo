// “最近删除”页的 hook：日程、待办、随手记里删了不到 30 天的，最近删的在前；恢复 = deleted_at 改回 null
// 永久删除、全部清空（purge_deleted，要联网）在 useTrashPurge.ts，这里不做
import { useCallback, useMemo } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { actionResult, type ActionResult as RestoreResult } from '../../../core/action-result.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { clock } from '../../../platform/clock.ts';
import { setDeleted, type TrashTable } from '../data/today-actions.ts';
import { trashOf } from '../data/trash.ts';
import type { Row } from '../data/today-model.ts';

export type { RestoreResult };

export function useTrash() {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const notes = useCollection<Row>('notes');
  const now = useMinuteNow();
  const items = useMemo(() => trashOf(events, todos, now, notes), [events, todos, now, notes]);
  const restore = useCallback(
    async (table: TrashTable, id: string): Promise<RestoreResult> => {
      const r = (table === 'todos' ? todos : table === 'notes' ? notes : events).find((x) => x.id === id);
      if (!r) return 'failed';
      return actionResult(await setDeleted(table, r, false, clock.now(), currentTz()));
    },
    [events, todos, notes],
  );
  return { items, restore };
}

/** 一类（待办或随手记）在“最近删除”里有几条：设置首页“最近删除”一组的条数（ui/TrashCount.tsx），和本页同一个数法（trashOf） */
export function useTrashCount(table: 'todos' | 'notes'): number {
  const rows = useCollection<Row>(table);
  const now = useMinuteNow();
  return useMemo(() => (table === 'todos' ? trashOf([], rows, now) : trashOf([], [], now, rows)).length, [table, rows, now]);
}
