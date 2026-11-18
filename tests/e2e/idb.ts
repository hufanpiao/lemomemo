// e2e 直接读写本机库 planner-v4 的共用写法（第三方审查 CI-14：原来二十多份用例各写一遍 indexedDB.open）。
// 都在页面里跑（page.evaluate）：页面有 CSP，不能把函数传进页面里 new Function，所以只传数据（仓名、行、键），读法按 op 分几种。
// 本机行的形状（src/core/cache-schema.ts）：{ id, server, view }；cached(row) 拼服务器已确认的那种（server、view 都是这一行）
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

export const DB = 'planner-v4';

/** 服务器已确认过的一行：{ id, server: row, view: row } */
export const cached = (row: Record<string, unknown>): Record<string, unknown> => ({ id: row['id'], server: row, view: row });

/**
 * 随手记显示方式两行（notes.view@mobile、notes.view@desktop，两类设备都写）：负责人 11-18 首装默认改列表（原来是瀑布流），
 * 测瀑布流卡片（notes-card-*、notes-mason）的用例要明确写 masonry。extra 给假服务器补公共列（user_id、synced_at 等）；
 * 灌本机库用 notesViewCached
 */
export const notesViewRows = (v: 'list' | 'masonry', extra: Record<string, unknown> = {}): Record<string, unknown>[] =>
  (['mobile', 'desktop'] as const).map((d, i) => ({ ...extra, id: `0e2e0000-0000-4000-8000-00000004619${i}`, key: `notes.view@${d}`, value: v, deleted_at: null, undone: false, rev: 1 }));
export const notesViewCached = (v: 'list' | 'masonry'): [string, Record<string, unknown>][] =>
  notesViewRows(v).map((r) => ['settings', cached(r)]);
/** 本机库写上显示方式两行再刷新（页面要先打开过、库已建好）：空库起步、又要看瀑布流卡片的用例用 */
export async function seedNotesView(page: Page, v: 'list' | 'masonry'): Promise<void> {
  await idbPut(page, notesViewCached(v));
  await page.reload();
}

/** 往本机库原样写几行（[仓名, 一行]），一个 readwrite 事务；不刷新 */
export async function idbPut(page: Page, rows: readonly (readonly [string, unknown])[]): Promise<void> {
  await page.evaluate(
    async ({ db: name, all }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(new Error(String(r.error)));
      });
      const tx = db.transaction([...new Set(all.map(([s]) => s))], 'readwrite');
      for (const [store, row] of all) tx.objectStore(store).put(row);
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(new Error(String(tx.error)));
      });
      db.close();
    },
    { db: DB, all: rows as [string, unknown][] },
  );
}

type ReadOp = 'get' | 'getAll' | 'getAllKeys' | 'count';

/**
 * 读一个仓：get（按 key）、getAll、getAllKeys、count。库不存在（不顺手建空库）或没有这个仓时回 null
 */
export async function idbRead<T>(page: Page, store: string, op: ReadOp, key?: string): Promise<T | null> {
  return page.evaluate(
    async ({ db: name, store, op, key }) => {
      if (!(await indexedDB.databases()).some((d) => d.name === name)) return null;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(new Error(String(r.error)));
      });
      try {
        if (!db.objectStoreNames.contains(store)) return null;
        const s = db.transaction(store, 'readonly').objectStore(store);
        const q: IDBRequest = op === 'get' ? s.get(key ?? '') : op === 'getAll' ? s.getAll() : op === 'getAllKeys' ? s.getAllKeys() : s.count();
        return await new Promise<unknown>((res, rej) => {
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(new Error(String(q.error)));
        });
      } finally {
        db.close();
      }
    },
    { db: DB, store, op, key },
  ) as Promise<T | null>;
}

/** 本机库现在的版本号（库不存在时 open 会建出 1 版空库，只在 App 已经建过库以后用） */
export function idbVersion(page: Page): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => {
          const v = req.result.version;
          req.result.close();
          resolve(v);
        };
        req.onerror = () => reject(new Error(String(req.error)));
      }),
    DB,
  );
}

/** 在 App 还没建库时，用指定版本建出只有一个 meta 仓的库（版本比 App 高：测“本机数据是新版本写的”） */
export function idbCreateAt(page: Page, version: number): Promise<void> {
  return page.evaluate(
    ({ name, version }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('meta');
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(new Error(String(req.error)));
      }),
    { name: DB, version },
  );
}

/** outbox 里一项在用例里关心的几列 */
export interface OutboxView {
  op_id: string;
  id: string;
  op: string;
  state: string;
  error: unknown;
}

/** 真后端组看本机库：库在不在、owner、outbox 各项、todos 的键。同一次 evaluate 里读完（几样是同一时刻的） */
export interface LocalState {
  exists: boolean;
  owner: string | null;
  outbox: OutboxView[];
  todoIds: string[];
}

export function localState(page: Page): Promise<LocalState> {
  return page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((d) => d.name === name)) return { exists: false, owner: null, outbox: [], todoIds: [] };
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = <T,>(store: string, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> =>
      db.objectStoreNames.contains(store)
        ? new Promise((res, rej) => {
            const q = op(db.transaction(store, 'readonly').objectStore(store));
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          })
        : Promise.resolve(null);
    const owner = (await all<{ value?: string } | undefined>('owner', (s) => s.get('user_id')))?.value ?? null;
    const items = (await all<Record<string, unknown>[]>('outbox', (s) => s.getAll())) ?? [];
    const outbox = items.map((x) => ({ op_id: String(x['op_id']), id: String(x['id']), op: String(x['op']), state: String(x['state']), error: x['error'] ?? null }));
    const todoIds = ((await all<IDBValidKey[]>('todos', (s) => s.getAllKeys())) ?? []).map(String);
    db.close();
    return { exists: true, owner, outbox, todoIds };
  }, DB);
}

/** 不在 App 上时（同源 /robots.txt）往 outbox 仓注入一条 todos 的 insert（格式按 src/core/outbox-types.ts 的 OutboxItem，v = 1）；返回记录 id */
export async function injectTodoInsert(page: Page, title: string): Promise<string> {
  await page.goto('/robots.txt');
  const id = randomUUID();
  const now = Date.now();
  await idbPut(page, [
    [
      'outbox',
      {
        op_id: randomUUID(), table: 'todos', id, rec: `todos:${id}`, op: 'insert',
        data: { id, title, created_at: now, updated_at: now }, base_rev: null, own_revs: [], client_ts: now,
        tries: 0, next_at: 0, state: 'pending', v: 1, app: '4.0.0', seq: 1, remind: false, deps: [], error: null,
      },
    ],
  ]);
  return id;
}

/** 待办 g1 在服务器上已删、outbox 里有它一项 gone 的 patch（改了标题，出同步提示卡）；n1 是一条普通待办。b2-sync-notice、b6-reduce-transparency 共用 */
export async function putGoneTodo(page: Page, base: Record<string, unknown>, due: string, opId: string): Promise<void> {
  const now = Date.now();
  await idbPut(page, [
    ['todos', cached({ ...base, id: 'g1', title: '交周报', due, rev: 3, deleted_at: now - 60000 })],
    ['todos', cached({ ...base, id: 'n1', title: '买牛奶', due, rev: 1, deleted_at: null })],
    [
      'outbox',
      {
        op_id: opId, table: 'todos', id: 'g1', rec: 'todos:g1', op: 'patch', data: { title: '交周报（改）' },
        base_rev: 2, own_revs: [], client_ts: now - 120000, tries: 0, next_at: 0, state: 'failed', v: 1, app: '4.0.0', seq: 1,
        remind: false, deps: [], error: 'gone', sent: true,
      },
    ],
  ]);
}
