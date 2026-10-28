// 订阅集合里的一条：useItem('todos', id)；这一条没变时不重画
import { useCallback, useSyncExternalStore } from 'react';
import { collection, type Row } from '../../core/store.ts';

export function useItem<T extends Row>(name: string, id: string | null): T | undefined {
  const c = collection<T>(name);
  const get = useCallback(() => (id === null ? undefined : c.get(id)), [c, id]);
  return useSyncExternalStore(c.subscribe, get, get);
}
