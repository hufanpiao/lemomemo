// 登录页数本机还没发的条数（R-382 架构 4.1a 第 2 点“换了账号登录”，0.59 安全审建议：登录页只读 outbox 的条数）
// • 只有一个 count()：按库名打开 planner-v4（不带版本号：不升级、不迁移），只对 outbox 仓调 IDBObjectStore.count()，
//   不读 server、view 两份，不读 outbox 条目的内容；读完马上关连接
// • 库不存在时不建库（onupgradeneeded 里中止）：回 0；没有 outbox 仓、打不开、被挡住、超时都回 null（界面不提示条数）
// • 登录页不跑 boot、不 import core（会带进 zod，见 features/auth/data/local-exit.ts），所以这里直接用 IndexedDB
import { LOCAL_DB_NAME } from './exit-basics.ts';

const OUTBOX_STORE = 'outbox';
export const OUTBOX_COUNT_TIMEOUT_MS = 2000;

export interface LocalOutbox {
  count(): Promise<number | null>;
}

export function createLocalOutbox(o: { factory?: IDBFactory; name?: string; timeoutMs?: number } = {}): LocalOutbox {
  return {
    count: () =>
      new Promise<number | null>((resolve) => {
        let done = false;
        let db: IDBDatabase | null = null;
        const finish = (v: number | null): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            db?.close();
          } catch {
            // 已关
          }
          resolve(v);
        };
        const timer = setTimeout(() => finish(null), o.timeoutMs ?? OUTBOX_COUNT_TIMEOUT_MS);
        try {
          const f = o.factory ?? globalThis.indexedDB;
          if (!f) return finish(null);
          const req = f.open(o.name ?? LOCAL_DB_NAME);
          let created = false;
          req.onupgradeneeded = () => {
            // 库本来不存在：不建（中止这次升级，open 随后报 AbortError）
            created = true;
            req.transaction?.abort();
          };
          req.onblocked = () => finish(null);
          req.onerror = () => finish(created ? 0 : null);
          req.onsuccess = () => {
            db = req.result;
            db.onversionchange = () => db?.close();
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) return finish(null);
            const c = db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).count();
            c.onsuccess = () => finish(typeof c.result === 'number' ? c.result : null);
            c.onerror = () => finish(null);
          };
        } catch {
          finish(null);
        }
      }),
  };
}

/** 默认那一份（登录页用） */
export const localOutbox: LocalOutbox = createLocalOutbox();
