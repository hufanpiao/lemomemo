// 登录页数本机还没发的条数（R-382 架构 4.1a 第 2 点“换了账号登录”，0.59 安全审建议：登录页只读 outbox 的条数）
// • 只有一个 count()：按库名打开 planner-v4（不带版本号：不升级、不迁移），只对 outbox 仓调 IDBObjectStore.count()，
//   不读 server、view 两份，不读 outbox 条目的内容；读完马上关连接
// • 开库经 shared/idb-open-existing.ts（和 SW 共用）：库不存在时不建库，回 0；没有 outbox 仓、打不开、被挡住、超时都回 null（界面不提示条数）
// • 登录页不跑 boot、不 import core（会带进 zod，见 features/auth/data/local-exit.ts），所以这里直接用 IndexedDB
import { openExistingDb } from '../../shared/idb-open-existing.ts';
import { LOCAL_DB_NAME } from './exit-basics.ts';

const OUTBOX_STORE = 'outbox';

export interface LocalOutbox {
  count(): Promise<number | null>;
}

export function createLocalOutbox(o: { factory?: IDBFactory; name?: string; timeoutMs?: number } = {}): LocalOutbox {
  return {
    count: async () => {
      const db = await openExistingDb<IDBDatabase>(o.factory ?? globalThis.indexedDB, o.name ?? LOCAL_DB_NAME, o.timeoutMs);
      if (db === 'missing') return 0;
      if (!db) return null;
      try {
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) return null;
        const c = db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).count();
        return await new Promise<number | null>((resolve) => {
          c.onsuccess = () => resolve(typeof c.result === 'number' ? c.result : null);
          c.onerror = () => resolve(null);
        });
      } catch {
        return null;
      } finally {
        db.close();
      }
    },
  };
}

/** 默认那一份（登录页用） */
export const localOutbox: LocalOutbox = createLocalOutbox();
