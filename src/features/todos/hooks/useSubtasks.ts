// 待办子任务的 hook（R-350）：按主待办分组的子任务（订阅 todo_items 集合）、列表页的收起状态
// • 收起状态（方案第 3 节、5.4，Q4）：每台设备各记各的、不同步，存本机库 meta 仓的 ui.todo_collapsed（待办 id → true 收起 / false 展开），
//   只存用户点过的；没点过的按默认：未完成展开、已完成收起。最多 COLLAPSED_MAX 个，写时剔掉已不在的待办、超了丢最早的。
//   读不到（没启动、库已关）就全按默认；不写 localStorage（4.1：localStorage 只留 install_id）
// • 收起状态放在模块里（离开待办页再回来不闪一下默认值）；第一次用时从 meta 读一次，读回来之前点过的以点过的为准
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getBoot } from '../../../core/boot.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { groupSubtasks, ITEMS_TABLE, progressOf, type Subtask } from '../data/todo-items.ts';
import type { Row } from '../data/todo-list.ts';

export type { Subtask } from '../data/todo-items.ts';

/** 按主待办分组的子任务（每组按排序键排；删了的不在里面） */
export function useSubtaskGroups(): ReadonlyMap<string, readonly Subtask[]> {
  return groupsOf(useCollection<Row>(ITEMS_TABLE));
}

/** 同一份集合快照只分一次组（今天页每条待办各挂一个进度，不各算一遍） */
const grouped = new WeakMap<readonly Row[], ReadonlyMap<string, readonly Subtask[]>>();
function groupsOf(rows: readonly Row[]): ReadonlyMap<string, readonly Subtask[]> {
  let g = grouped.get(rows);
  if (!g) grouped.set(rows, (g = groupSubtasks(rows)));
  return g;
}

/** 一条待办的子任务进度（今天页用）；没有子任务为 null */
export function useSubtaskProgress(todoId: string): { done: number; total: number } | null {
  const items = useSubtaskGroups().get(todoId);
  return items?.length ? progressOf(items) : null;
}

/**
 * 勾下去当下就按“刚点的值”画（不等保存回来；同主待办的 shown）：pick(id, v) 记下，shown(item) 先看记下的；
 * 集合跟上了（或这一项没了）就丢掉。列表页卡片、编辑页共用
 */
export function usePicked(items: readonly Subtask[]): { shown(i: Subtask): boolean; pick(id: string, v: boolean): void } {
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  useEffect(() => {
    setPicked((m) => {
      const keep = [...m].filter(([id, v]) => items.some((i) => i.id === id && i.done !== v));
      return keep.length === m.size ? m : new Map(keep);
    });
  }, [items]);
  return { shown: (i) => picked.get(i.id) ?? i.done, pick: (id, v) => setPicked((m) => new Map(m).set(id, v)) };
}

const META_KEY = 'ui.todo_collapsed';
export const COLLAPSED_MAX = 500;

let collapsed: Readonly<Record<string, boolean>> = {};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => collapsed;

function openCache() {
  const c = getBoot()?.cache;
  return c && !c.isClosed() ? c : null;
}

function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const c = openCache();
      if (!c) {
        loading = null;   // 还没启动好：下次进待办页再读
        return;
      }
      const v = await c.getMeta(META_KEY);
      if (v && typeof v === 'object') {
        collapsed = { ...v, ...collapsed };
        emit();
      }
    } catch {
      loading = null;   // 读不到先按默认（meta 可重建），下次再试
    }
  })();
  return loading;
}

/** 记下一条的收起状态：剔掉已不在的待办（live），超过上限丢最早记的；写 meta 失败不提示（下次打开回到默认） */
export function setCollapsed(id: string, value: boolean, live: ReadonlySet<string>): void {
  const keep = Object.entries(collapsed).filter(([k]) => k !== id && live.has(k));
  keep.push([id, value]);
  collapsed = Object.fromEntries(keep.slice(-COLLAPSED_MAX));
  emit();
  void openCache()?.setMeta(META_KEY, collapsed).catch(() => undefined);
}

/** 测试用：清掉模块里的状态 */
export function resetCollapsedForTest(): void {
  collapsed = {};
  loading = null;
}

/** 列表页：这条待办的子任务收起没有（点过的按点过的；没点过的已完成收起、未完成展开） */
export function useCollapsed(): (id: string, done: boolean) => boolean {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void load();
  }, []);
  return (id, done) => s[id] ?? done;
}
