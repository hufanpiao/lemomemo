// 按集合订阅的 store（架构 2.0、2.1）：数据层是唯一真相，React 只经 useSyncExternalStore 订阅
// 每个集合一份快照：一个集合变了，只通知订阅它的组件（2.6 渲染性能）
// B0 只有内存版骨架；B1 接上 IndexedDB（core/cache）、outbox 和同步后，写入从那里进来
// 纯 TS：不准 import React 和任何功能（A1）

export interface Row {
  id: string;
}

type Listener = () => void;

export interface Collection<T extends Row> {
  /** 订阅这个集合的变化，返回取消函数 */
  subscribe(listener: Listener): () => void;
  /** 当前快照：内容不变时返回同一个数组（useSyncExternalStore 要求） */
  getSnapshot(): readonly T[];
  /** 按 id 取一条；不存在返回 undefined */
  get(id: string): T | undefined;
  /** 写入或替换若干条（来自本机缓存、同步、outbox 叠加后的 view） */
  upsert(rows: readonly T[]): void;
  /** 移除若干条 */
  remove(ids: readonly string[]): void;
  /** 清空（退出登录、换账号） */
  clear(): void;
}

export function createCollection<T extends Row>(): Collection<T> {
  const byId = new Map<string, T>();
  const listeners = new Set<Listener>();
  let snapshot: readonly T[] = [];

  const commit = (): void => {
    snapshot = [...byId.values()];
    for (const l of [...listeners]) l();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    get: (id) => byId.get(id),
    upsert(rows) {
      if (rows.length === 0) return;
      for (const r of rows) byId.set(r.id, r);
      commit();
    },
    remove(ids) {
      let changed = false;
      for (const id of ids) changed = byId.delete(id) || changed;
      if (changed) commit();
    },
    clear() {
      if (byId.size === 0) return;
      byId.clear();
      commit();
    },
  };
}

/** 全局集合登记：同名集合只建一次。集合名就是清单里的表名 */
const registry = new Map<string, Collection<Row>>();

export function collection<T extends Row>(name: string): Collection<T> {
  let c = registry.get(name);
  if (!c) {
    c = createCollection<Row>();
    registry.set(name, c);
  }
  // 同名集合的行类型由调用方保证一致（集合名和行类型一一对应，见各功能 data/）
  return c as unknown as Collection<T>;
}

/** 清空所有集合（退出登录、换账号；测试之间） */
export function clearAllCollections(): void {
  for (const c of registry.values()) c.clear();
}
