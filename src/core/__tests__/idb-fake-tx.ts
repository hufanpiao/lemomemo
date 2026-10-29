// 测试用 IndexedDB 替身的事务、仓、请求部分（idb-fake.ts 用；不是测试文件本身）
import type { FakeDB } from './idb-fake.ts';
import { FakeObjectStore } from './idb-fake-store.ts';

export { FakeIndex, FakeObjectStore } from './idb-fake-store.ts';

export type Key = string | number;
export type Value = Record<string, unknown>;

export interface IndexMeta {
  keyPath: string;
  unique: boolean;
  multiEntry: boolean;
}

export interface StoreData {
  keyPath: string;
  records: Map<Key, Value>;
  indexes: Map<string, IndexMeta>;
}

export interface DbData {
  version: number;
  stores: Map<string, StoreData>;
  connections: Set<FakeDB>;
  /** 还没结束的事务（按创建顺序），调度用 */
  txs: FakeTransaction[];
}

// 宏任务：优先 setImmediate（jsdom 的 setTimeout 嵌套多了会被限到 4 ms，事务一长测试就慢）
const later: (fn: () => void) => void =
  typeof (globalThis as { setImmediate?: unknown }).setImmediate === 'function'
    ? (fn) => {
        (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(fn);
      }
    : (fn) => {
        setTimeout(fn, 0);
      };

export const tick = (fn: () => void): void => {
  later(fn);
};

export function cloneStores(stores: Map<string, StoreData>): Map<string, StoreData> {
  const out = new Map<string, StoreData>();
  for (const [n, s] of stores) {
    out.set(n, { keyPath: s.keyPath, records: new Map([...s.records].map(([k, v]) => [k, structuredClone(v)])), indexes: new Map(s.indexes) });
  }
  return out;
}

export function cmp(a: Key, b: Key): number {
  if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
  return typeof a === 'number' ? -1 : 1;
}

export class FakeStringList {
  private readonly get: () => string[];
  constructor(get: () => string[]) {
    this.get = get;
  }
  contains(n: string): boolean {
    return this.get().includes(n);
  }
  item(i: number): string | null {
    return this.get()[i] ?? null;
  }
  get length(): number {
    return this.get().length;
  }
  [Symbol.iterator](): Iterator<string> {
    return this.get()[Symbol.iterator]();
  }
}

export interface ErrEvent {
  target: unknown;
  preventDefault(): void;
  defaultPrevented: boolean;
}

export function errEvent(target: unknown): ErrEvent {
  const e = {
    target,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  return e;
}

export class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  readyState: 'pending' | 'done' = 'pending';
  onsuccess: ((e: unknown) => void) | null = null;
  onerror: ((e: ErrEvent) => void) | null = null;
  readonly source: unknown;
  transaction: FakeTransaction | null;
  constructor(source: unknown, transaction: FakeTransaction | null) {
    this.source = source;
    this.transaction = transaction;
  }
}

export class FakeOpenRequest extends FakeRequest {
  onupgradeneeded: ((e: { oldVersion: number; newVersion: number; target: unknown }) => void) | null = null;
  onblocked: (() => void) | null = null;
  constructor() {
    super(null, null);
  }
}

/**
 * 事务（保真度按 K6 审查 L1 补过）：
 * - 调度：按创建顺序；和更早、还没结束、范围重叠的事务冲突（任一方是 readwrite / versionchange）时等它结束再开始，
 *   所以两个 readwrite 串行、只读事务读不到别人没提交的写入（没有脏读）；
 * - 活动期：创建时和每个请求的回调（及回调引起的微任务）里是活动的，回调所在的宏任务结束就不活动；
 *   不活动时发请求抛 TransactionInactiveError（例如 await 了定时器或网络之后）；
 * - 没有排着的请求、又不活动时自动提交；成功回调里抛错时事务中止；中止时把范围内的仓恢复到开始时的样子
 */
export class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  error: DOMException | null = null;
  private queue: { req: FakeRequest; run: () => unknown }[] = [];
  private active = true;
  private started = false;
  private stepping = false;
  private finished = false;
  private snapshot: Map<string, StoreData> | null = null;
  readonly objectStoreNames: FakeStringList;
  readonly db: FakeDB;
  private readonly names: string[];
  readonly mode: IDBTransactionMode;
  private readonly onFinish: ((ok: boolean) => void) | undefined;

  constructor(db: FakeDB, names: string[], mode: IDBTransactionMode, onFinish?: (ok: boolean) => void) {
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.onFinish = onFinish;
    this.objectStoreNames = new FakeStringList(() => (mode === 'versionchange' ? [...db.data.stores.keys()] : [...names]));
    db.data.txs.push(this);
    if (mode === 'versionchange') this.start();
    // 创建所在的宏任务结束：不再活动，能开始就开始
    tick(() => {
      this.active = false;
      if (this.started) this.step();
      else schedule(db.data);
    });
  }

  private overlaps(o: FakeTransaction): boolean {
    if (this.mode === 'versionchange' || o.mode === 'versionchange') return true;
    return this.names.some((n) => o.names.includes(n));
  }

  /** 调度器调：前面没有冲突的事务时开始 */
  tryStart(): void {
    if (this.started || this.finished) return;
    const list = this.db.data.txs;
    for (const o of list) {
      if (o === this) break;
      if (o.finished || !this.overlaps(o)) continue;
      if (this.mode !== 'readonly' || o.mode !== 'readonly') return;
    }
    this.start();
    if (!this.active) this.step();
  }

  private start(): void {
    this.started = true;
    const data = this.db.data;
    const scope = this.mode === 'versionchange' ? data.stores : new Map([...data.stores].filter(([n]) => this.names.includes(n)));
    this.snapshot = cloneStores(scope);
  }

  objectStore(name: string): FakeObjectStore {
    if (this.finished) throw new DOMException('transaction finished', 'TransactionInactiveError');
    if (this.mode !== 'versionchange' && !this.names.includes(name)) throw new DOMException(name, 'NotFoundError');
    if (!this.db.data.stores.has(name)) throw new DOMException(name, 'NotFoundError');
    return new FakeObjectStore(this, name);
  }

  enqueue(source: unknown, run: () => unknown): FakeRequest {
    if (this.finished || !this.active) throw new DOMException('transaction not active', 'TransactionInactiveError');
    const req = new FakeRequest(source, this);
    this.queue.push({ req, run });
    return req;
  }

  /** 执行下一个请求（一个宏任务一个）；没有请求就提交 */
  private step(): void {
    if (this.finished || this.stepping) return;
    if (!this.queue.length) {
      this.commit();
      return;
    }
    this.stepping = true;
    tick(() => {
      this.stepping = false;
      if (this.finished) return;
      const next = this.queue.shift();
      if (!next) {
        this.step();
        return;
      }
      const { req, run } = next;
      this.active = true;
      try {
        req.result = run();
        req.readyState = 'done';
        try {
          req.onsuccess?.({ target: req });
        } catch {
          this.doAbort(new DOMException('success handler threw', 'AbortError'));
          return;
        }
      } catch (e) {
        req.readyState = 'done';
        req.error = e instanceof DOMException ? e : new DOMException(String(e), 'UnknownError');
        const ev = errEvent(req);
        req.onerror?.(ev);
        if (!ev.defaultPrevented) {
          this.onerror?.(ev);
          if (!ev.defaultPrevented) {
            this.doAbort(req.error);
            return;
          }
        }
      }
      // 回调里的微任务（await 之后接着发的请求）都在这之前跑完
      tick(() => {
        this.active = false;
        this.step();
      });
    });
  }

  private commit(): void {
    if (this.finished || this.active || !this.started) return;
    this.finished = true;
    this.onFinish?.(true);
    this.oncomplete?.();
    this.release();
  }

  abort(): void {
    if (this.finished) throw new DOMException('transaction finished', 'InvalidStateError');
    this.doAbort(new DOMException('aborted', 'AbortError'));
  }

  private doAbort(err: DOMException): void {
    if (this.finished) return;
    this.finished = true;
    this.error = err;
    this.queue = [];
    if (this.snapshot) {
      for (const [n, s] of this.snapshot) this.db.data.stores.set(n, s);
      if (this.mode === 'versionchange') {
        for (const n of [...this.db.data.stores.keys()]) if (!this.snapshot.has(n)) this.db.data.stores.delete(n);
      }
    }
    this.onFinish?.(false);
    tick(() => this.onabort?.());
    this.release();
  }

  private release(): void {
    const list = this.db.data.txs;
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
    schedule(this.db.data);
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

/** 按创建顺序试着开始还没开始的事务 */
export function schedule(data: DbData): void {
  for (const t of [...data.txs]) t.tryStart();
}
