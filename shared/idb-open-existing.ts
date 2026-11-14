// 按库名“只打开、不新建”本机库（第三方审查第 11 条：SW 的 src/sw/pending.ts、登录页的 platform/local-outbox.ts 共用这一份）
// • 不带版本号打开：不升级、不迁移。库不存在时浏览器会走一次 oldVersion 为 0 的升级，这里当场中止，不留下新建的库，回 'missing'
// • 打不开、被挡住、OPEN_EXISTING_TIMEOUT_MS 内没打开都回 null；超时以后才打开的连接当场关掉
// • 开好的连接挂 onversionchange 就关：别处删库、升级不被它挡住。读写、用完关连接由调用方做（这里不开事务）
// • shared 的 lib 不带 DOM、WebWorker：只按结构认 IndexedDB 的几个成员，调用方传 IDBFactory、拿回 IDBDatabase；不 import 任何东西
export const OPEN_EXISTING_TIMEOUT_MS = 2000;

// shared 的 lib 不带计时器的类型（页面、SW 都有这两个全局函数）
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(t: unknown): void;

interface DbLike {
  close(): void;
}

interface OpenRequest<D> {
  readonly result: D;
  readonly transaction: { abort(): void } | null;
  onupgradeneeded: ((e: { oldVersion: number }) => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

export function openExistingDb<D extends DbLike>(
  factory: { open(name: string): unknown } | undefined, name: string, ms: number = OPEN_EXISTING_TIMEOUT_MS,
): Promise<D | 'missing' | null> {
  return new Promise((resolve) => {
    let settled = false;
    let missing = false;
    const finish = (v: D | 'missing' | null): void => {
      if (settled) {
        if (v !== null && v !== 'missing') v.close();   // 超时以后才打开：没人用，关掉
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    try {
      if (!factory) return finish(null);
      const req = factory.open(name) as OpenRequest<D>;
      req.onupgradeneeded = (e) => {
        if (e.oldVersion !== 0) return;
        missing = true;
        try {
          req.transaction?.abort();
        } catch {
          // 已经结束的事务再 abort 会抛：onerror / onsuccess 里照样按 missing 处理
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (missing) {
          db.close();
          return finish('missing');
        }
        (db as unknown as { onversionchange: () => void }).onversionchange = () => db.close();
        finish(db);
      };
      req.onerror = () => finish(missing ? 'missing' : null);
      req.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}
