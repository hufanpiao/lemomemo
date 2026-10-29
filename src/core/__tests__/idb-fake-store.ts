// 测试用 IndexedDB 替身的仓和索引（idb-fake-tx.ts 用；不是测试文件本身）
import { cmp, FakeStringList, type FakeRequest, type FakeTransaction, type Key, type StoreData, type Value } from './idb-fake-tx.ts';

export class FakeIndex {
  private readonly store: FakeObjectStore;
  readonly name: string;
  constructor(store: FakeObjectStore, name: string) {
    this.store = store;
    this.name = name;
  }
  getAll(key?: Key): FakeRequest {
    return this.store.tx.enqueue(this, () => {
      const s = this.store.data();
      const meta = s.indexes.get(this.name);
      if (!meta) throw new DOMException(this.name, 'NotFoundError');
      return [...s.records.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([, v]) => v)
        .filter((v) => key === undefined || v[meta.keyPath] === key)
        .map((v) => structuredClone(v));
    });
  }
}

export class FakeObjectStore {
  readonly tx: FakeTransaction;
  readonly name: string;
  constructor(tx: FakeTransaction, name: string) {
    this.tx = tx;
    this.name = name;
  }
  data(): StoreData {
    const s = this.tx.db.data.stores.get(this.name);
    if (!s) throw new DOMException(this.name, 'InvalidStateError');
    return s;
  }
  get keyPath(): string {
    return this.data().keyPath;
  }
  get indexNames(): FakeStringList {
    return new FakeStringList(() => [...this.data().indexes.keys()]);
  }
  private writable(): void {
    if (this.tx.mode === 'readonly') throw new DOMException('readonly', 'ReadOnlyError');
  }
  put(value: Value): FakeRequest {
    this.writable();
    const key = value[this.keyPath];
    if (typeof key !== 'string' && typeof key !== 'number') throw new DOMException('no key', 'DataError');
    const v = structuredClone(value);
    return this.tx.enqueue(this, () => {
      this.data().records.set(key, v);
      return key;
    });
  }
  get(key: Key): FakeRequest {
    return this.tx.enqueue(this, () => {
      const v = this.data().records.get(key);
      return v === undefined ? undefined : structuredClone(v);
    });
  }
  getAll(): FakeRequest {
    return this.tx.enqueue(this, () =>
      [...this.data().records.entries()].sort(([a], [b]) => cmp(a, b)).map(([, v]) => structuredClone(v)),
    );
  }
  count(): FakeRequest {
    return this.tx.enqueue(this, () => this.data().records.size);
  }
  delete(key: Key): FakeRequest {
    this.writable();
    return this.tx.enqueue(this, () => {
      this.data().records.delete(key);
      return undefined;
    });
  }
  clear(): FakeRequest {
    this.writable();
    return this.tx.enqueue(this, () => {
      this.data().records.clear();
      return undefined;
    });
  }
  index(name: string): FakeIndex {
    if (!this.data().indexes.has(name)) throw new DOMException(name, 'NotFoundError');
    return new FakeIndex(this, name);
  }
  createIndex(name: string, keyPath: string, opts: { unique?: boolean; multiEntry?: boolean } = {}): FakeIndex {
    if (this.tx.mode !== 'versionchange') throw new DOMException('not versionchange', 'InvalidStateError');
    this.data().indexes.set(name, { keyPath, unique: opts.unique === true, multiEntry: opts.multiEntry === true });
    return new FakeIndex(this, name);
  }
  deleteIndex(name: string): void {
    if (this.tx.mode !== 'versionchange') throw new DOMException('not versionchange', 'InvalidStateError');
    this.data().indexes.delete(name);
  }
}
