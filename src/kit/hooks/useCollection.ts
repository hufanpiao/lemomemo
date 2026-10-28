// 订阅一个集合（架构 2.0）：useCollection('todos')
// kit/hooks 是除功能 hooks 外唯一能同时碰 React 和数据层的地方（A1）
import { useSyncExternalStore } from 'react';
import { collection, type Row } from '../../core/store.ts';

export function useCollection<T extends Row>(name: string): readonly T[] {
  const c = collection<T>(name);
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}
