// 测试用的最小 IndexedDB 替身（仓库没有 fake-indexeddb，不加依赖）：只实现 core/cache*.ts、outbox.ts 用到的部分
// • open：建库、升级（onupgradeneeded + versionchange 事务）、VersionError、通知旧连接 onversionchange、blocked
// • deleteDatabase：通知旧连接、等关、blocked，删掉
// • 事务：范围重叠的按创建顺序串行（只读和只读可并行）、活动期检查、请求按顺序在宏任务里执行；没有新请求时自动提交；
//   成功回调抛错就中止；中止时把涉及的仓恢复原样（升级事务中止时整库恢复）。细节见 idb-fake-tx.ts 的 FakeTransaction
// • 仓：put / get / getAll / delete / clear / count、index(name).getAll(key)、createIndex / deleteIndex
// 不是测试文件本身（文件名不以 .test.ts 结尾）

import {
  errEvent,
  FakeObjectStore,
  FakeOpenRequest,
  FakeStringList,
  FakeTransaction,
  tick,
  type DbData,
} from './idb-fake-tx.ts';

export class FakeDB {
  onversionchange: ((e: { oldVersion: number; newVersion: number | null }) => void) | null = null;
  closed = false;
  upgradeTx: FakeTransaction | null = null;
  readonly objectStoreNames: FakeStringList;
  readonly factory: FakeIDBFactory;
  readonly name: string;
  readonly data: DbData;
  version: number;
  constructor(factory: FakeIDBFactory, name: string, data: DbData, version: number) {
    this.factory = factory;
    this.name = name;
    this.data = data;
    this.version = version;
    this.objectStoreNames = new FakeStringList(() => [...data.stores.keys()]);
  }
  createObjectStore(name: string, opts: { keyPath: string }): FakeObjectStore {
    if (!this.upgradeTx || this.upgradeTx.isFinished) throw new DOMException('not versionchange', 'InvalidStateError');
    if (this.data.stores.has(name)) throw new DOMException(name, 'ConstraintError');
    this.data.stores.set(name, { keyPath: opts.keyPath, records: new Map(), indexes: new Map() });
    return new FakeObjectStore(this.upgradeTx, name);
  }
  deleteObjectStore(name: string): void {
    if (!this.upgradeTx || this.upgradeTx.isFinished) throw new DOMException('not versionchange', 'InvalidStateError');
    if (!this.data.stores.delete(name)) throw new DOMException(name, 'NotFoundError');
  }
  transaction(names: string | string[], mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this.data.stores.has(n)) throw new DOMException(n, 'NotFoundError');
    return new FakeTransaction(this, list, mode);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.data.connections.delete(this);
    this.factory.connectionClosed();
  }
}

export class FakeIDBFactory {
  readonly dbs = new Map<string, DbData>();
  private waiters: (() => void)[] = [];

  connectionClosed(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  open(name: string, version?: number): FakeOpenRequest {
    const req = new FakeOpenRequest();
    tick(() => {
      let data = this.dbs.get(name);
      const oldVersion = data?.version ?? 0;
      const newVersion = version ?? (oldVersion || 1);
      if (newVersion < oldVersion) {
        req.error = new DOMException('requested version is less than existing', 'VersionError');
        req.readyState = 'done';
        req.onerror?.(errEvent(req));
        return;
      }
      if (!data) {
        data = { version: 0, stores: new Map(), connections: new Set(), txs: [] };
        this.dbs.set(name, data);
      }
      const d = data;
      if (newVersion === oldVersion) {
        const db = new FakeDB(this, name, d, oldVersion);
        d.connections.add(db);
        req.result = db;
        req.readyState = 'done';
        req.onsuccess?.({ target: req });
        return;
      }
      // 要升级：先通知别的连接
      for (const c of [...d.connections]) c.onversionchange?.({ oldVersion, newVersion });
      const proceed = (): void => {
        const db = new FakeDB(this, name, d, newVersion);
        d.connections.add(db);
        const before = d.version;
        d.version = newVersion;
        const tx = new FakeTransaction(db, [], 'versionchange', (ok) => {
          db.upgradeTx = null;
          req.transaction = null;
          if (ok) {
            req.readyState = 'done';
            tick(() => req.onsuccess?.({ target: req }));
          } else {
            d.version = before;
            d.connections.delete(db);
            db.closed = true;
            req.error = new DOMException('upgrade aborted', 'AbortError');
            req.readyState = 'done';
            tick(() => req.onerror?.(errEvent(req)));
          }
        });
        db.upgradeTx = tx;
        req.result = db;
        req.transaction = tx;
        try {
          req.onupgradeneeded?.({ oldVersion, newVersion, target: req });
        } catch {
          tx.abort();
        }
      };
      const waitClosed = (blockedFired: boolean): void => {
        if (d.connections.size === 0) {
          proceed();
          return;
        }
        if (!blockedFired) req.onblocked?.();
        this.waiters.push(() => waitClosed(true));
      };
      tick(() => waitClosed(false));
    });
    return req;
  }

  /** 按库名删库：先通知还开着的连接 onversionchange（newVersion 为 null），等都关了再删；没关时先触发 blocked */
  deleteDatabase(name: string): FakeOpenRequest {
    const req = new FakeOpenRequest();
    tick(() => {
      const d = this.dbs.get(name);
      const done = (): void => {
        this.dbs.delete(name);
        req.readyState = 'done';
        req.onsuccess?.({ target: req });
      };
      if (!d) {
        done();
        return;
      }
      for (const c of [...d.connections]) c.onversionchange?.({ oldVersion: d.version, newVersion: null });
      const waitClosed = (blockedFired: boolean): void => {
        if (d.connections.size === 0) {
          done();
          return;
        }
        if (!blockedFired) req.onblocked?.();
        this.waiters.push(() => waitClosed(true));
      };
      tick(() => waitClosed(false));
    });
    return req;
  }
}

/** 新建一个替身，转成 IDBFactory 的类型给 openCache 用 */
export function fakeIndexedDB(): { factory: IDBFactory; fake: FakeIDBFactory } {
  const fake = new FakeIDBFactory();
  return { factory: fake as unknown as IDBFactory, fake };
}

/** 等所有排着的宏任务跑完几轮 */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
