// 本机缓存（架构 4.1、0.27 第 1 点）：IndexedDB，库名 planner-v4
// • 每张同步表一个仓（按数据清单建，见 cache-schema.ts），每行存 server（服务器上的值）和 view（叠加本机未发出的修改后的值）
// • meta：同步游标、整表同步时间、config、profile、待补拉 id（键见 MetaMap）
// • owner：这个库归哪个账号（core/account.ts；迁移失败也不动）
// • outbox：离线写入队列（读写经 core/outbox.ts，别处不直接写这个仓）
// • drafts、vault_drafts、pending_actions：本机专用，迁移失败也不动
// • 4.0.0 起监听 onversionchange：别的标签页要升级时，先跑登记的“关库前”回调（把编辑中的内容写进 drafts），再关库、挡住写入
// • 不支持降级：库版本比 App 高时 open 报 VersionError，返回 version_too_new，不删库
// 隐私记的明文不进这里（A18：features/vault/data 不准 import 本文件）
// 纯 TS：不准 import React 和任何功能（A1）
import type { FeaturesConfig } from '../../shared/logic/flags.ts';
import { cacheMigrations, DB_VERSION, runUpgrade, type CacheMigration, type UpgradeReport } from './cache-migrations.ts';
import { cacheStores, DRAFTS, META, VAULT_DRAFTS, type StoreDef } from './cache-schema.ts';
import { deleteLocalDb, type DeleteDbResult } from '../platform/sign-out.ts';

export const DB_NAME = 'planner-v4';

/** 同步表的一行（服务器形状；K7 宽容读取负责把网络数据变成它） */
export type ServerRow = Readonly<Record<string, unknown>> & { readonly id: string };

/** 同步仓里存的一条 */
export interface CachedRow<T extends ServerRow = ServerRow> {
  id: string;
  /** 服务器上的值；离线新建、还没上服务器的是 null */
  server: T | null;
  /** 叠加 outbox 里还没确认的修改以后、界面上显示的值；null 表示界面上没有这一条 */
  view: T | null;
  /** K7 宽容读取写：这一行带不认识的值，只读（outbox.enqueue 一律拒收，错误码 readonly_row） */
  ro?: true;
  /**
   * 本机写出、但 server 副本还没反映的 rev（确认时中间夹了别的设备的写入，4.2 S1）：
   * 新入队的 patch 带上它当 own_revs；服务器的新行到了以后去掉不大于新 rev 的。由 outbox.ts 维护
   */
  own_revs?: number[];
  /**
   * R-229 空壳的门槛（outbox-rows.ts 的 applyServerRows 维护，不放进 server）：写空壳时从原始行的 minRev、本机旧 server 的 rev、
   * 旧门槛里取最大的；之后这一行只收过了门槛的服务器行，免得晚到的旧普通行把明文带回来；正常行收进来以后清掉
   */
  shell_rev?: number;
  /**
   * 门槛含不含等于：门槛来自原始行的 minRev 时为 true（收 rev ≥ shell_rev：升级后整表重拉同 rev 的好行要能收进来，TC-B1-40）；
   * 拿本机旧 rev 补的为 false（严格大于：同 rev 就是本机原来那份旧行）。和 shell_rev 同生同灭
   */
  shell_inclusive?: boolean;
}

/** 某张同步表的增量同步进度（K8 写） */
export interface SyncCursor {
  /** 上次增量拉到的 synced_at（ISO 字符串）；null 表示还没拉过 */
  cursor: string | null;
  /** 上次整表同步完成的时间（epoch ms）；超过 25 天整表重拉 */
  fullSyncAt: number | null;
}

/** app_config 中本人能读的列（整行存，启动和切到前台时整行刷新，0.27 第 4 点） */
export interface CachedConfig {
  min_client_version?: string;
  latest_version?: string;
  features?: FeaturesConfig;
  [col: string]: unknown;
}

/** profiles 本人那一行（整行存） */
export interface CachedProfile {
  id: string;
  beta_features?: readonly string[];
  [col: string]: unknown;
}

/** 队列因 426 暂停（0.27 第 1 点）：记下当时的 App 版本，新版启动时（版本变了）自动解除 */
export interface OutboxPause {
  reason: 'upgrade';
  /** 426 响应体里的 min；拿不到时为 null */
  min: string | null;
  /** 暂停时的 App 版本 */
  app: string;
  at: number;
}

/** 本会话的 devices 行：id、它绑着的会话；ok = 服务器上已确认有这一行（false = 已选好 id、insert 还没确认） */
export interface DeviceMeta {
  id: string;
  session: string;
  ok: boolean;
  /** 上次写 last_seen_at、app_version 的时刻（毫秒；insert 或每天一次的刷新），没有为还没写过 */
  seenAt?: number;
  /** 上次写进去的 app_version */
  ver?: string;
}

/** meta 仓的键和值的类型 */
export interface MetaMap {
  /** 写进缓存时的 rows.ts 版本（shared/schema/rows.ts 的 SCHEMA_V）；变了就整表重拉（2.6，TC-B1-40） */
  schema_v: number;
  config: CachedConfig;
  profile: CachedProfile;
  outbox_pause: OutboxPause;
  /** 本会话的 devices 行（core/device-reg.ts；0.38 第 62 条④）：退出、换账号、被移除时随整库清掉 */
  device: DeviceMeta;
  /** 队列连续收到 try_later 的次数（TC-B1-90，续第 119 条②；core/outbox-send.ts 读写，发送成功或别的失败时删掉） */
  try_later_streak: number;
  /** 各表的同步游标（K8） */
  [k: `cursor:${string}`]: SyncCursor;
  /** 各表“待补拉”的 id（K7：一行解析不了时记下，下次启动单独补拉） */
  [k: `refetch:${string}`]: readonly string[];
}
export type MetaKey = keyof MetaMap & string;

/** 草稿（录音、编辑中的内容）；data 的形状由各功能自己定 */
export interface Draft {
  id: string;
  /** 哪种草稿，例如 'capture'、'note-edit' */
  kind: string;
  data: unknown;
  updated_at: number;
}

/** 事务里能做的事；fn 里只能 await 本事务的请求，不要 await 网络或定时器（事务没有请求时会自动提交） */
export interface CacheTx {
  get<T>(store: string, key: IDBValidKey): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  getAllByIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]>;
  put(store: string, value: unknown): Promise<void>;
  delete(store: string, key: IDBValidKey): Promise<void>;
  clear(store: string): Promise<void>;
}

/** versionchange：别的标签页要升级库；deleted：别处在按库名删库（versionchange 的 newVersion 为 null，退出登录）；closed：自己调了 close */
export type CacheCloseReason = 'versionchange' | 'deleted' | 'closed';

/** tx 的选项 */
export interface CacheTxOptions {
  /**
   * 封存（seal）以后照样能开的 readwrite 事务。**只有清空用**：core/account.ts 的 claimCache 和 clearAll，
   * 别处不准传（封存就是为了挡住换账号途中别的写入）
   */
  bypassSeal?: boolean;
}

export interface Cache {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly StoreDef[];
  /** 同步仓的名字（= 清单里 sync: true 的表） */
  readonly syncTables: readonly string[];
  /** 库已关（或正在为升级关库）：写入会被拒绝（CacheClosedError） */
  isClosed(): boolean;
  /** 跨仓的原子操作；fn 抛错时整个事务回滚。封存以后 readwrite 一律抛 CacheClosedError（opts.bypassSeal 例外） */
  tx<R>(stores: readonly string[], mode: IDBTransactionMode, fn: (t: CacheTx) => Promise<R>, opts?: CacheTxOptions): Promise<R>;
  /** 库里实际存在的全部仓名（含 stores 以外、旧版本留下的仓） */
  storeNames(): string[];
  /**
   * 封存（换账号、被移除时由 core/account.ts 同步调，K6 复审 N2）：之后新的 readwrite 事务一律抛 CacheClosedError，
   * 只有清空（claimCache、clearAll）能写；读照常。不能解除，随后关库
   */
  seal(): void;
  isSealed(): boolean;

  getRow<T extends ServerRow = ServerRow>(table: string, id: string): Promise<CachedRow<T> | undefined>;
  allRows<T extends ServerRow = ServerRow>(table: string): Promise<CachedRow<T>[]>;
  /** 只写 cache，不碰 outbox、不通知集合；正常的写入经 core/outbox.ts */
  putRows(table: string, rows: readonly CachedRow[]): Promise<void>;
  deleteRows(table: string, ids: readonly string[]): Promise<void>;

  getMeta<K extends MetaKey>(key: K): Promise<MetaMap[K] | undefined>;
  setMeta<K extends MetaKey>(key: K, value: MetaMap[K]): Promise<void>;
  deleteMeta(key: MetaKey): Promise<void>;

  putDraft(d: Draft): Promise<void>;
  getDraft(id: string): Promise<Draft | undefined>;
  allDrafts(): Promise<Draft[]>;
  deleteDraft(id: string): Promise<void>;

  /**
   * 清空库里实际存在的全部仓（含 outbox、drafts、vault_drafts、pending_actions、owner，以及 stores 以外的旧仓）：退出登录、被移除（4.1）；
   * 封存以后照样能清。换账号走 core/account.ts 的 claimCache（比对和清空在同一个事务里）
   */
  clearAll(): Promise<void>;
  /**
   * 登记“关库前要做的事”：别的标签页以更高版本打开库时先跑它（例如把录音、编辑中的内容写进 drafts），
   * 每个回调最多等 2 秒；这时只有 drafts、vault_drafts 还能写。返回取消函数
   */
  onBeforeVersionClose(fn: () => Promise<void> | void): () => void;
  /** 库关了（versionchange：别的标签页要升级；deleted：别处在删库；closed：自己调了 close） */
  onClosed(fn: (reason: CacheCloseReason) => void): () => void;
  close(): void;
}

export class CacheClosedError extends Error {
  override name = 'CacheClosedError';
  constructor() {
    super('cache_closed');
  }
}

export type OpenCacheResult =
  | { ok: true; cache: Cache; upgrade: UpgradeReport }
  /**
   * version_too_new：本机库来自更新的版本（VersionError），整屏提示“请更新柠檬记”，不删库（TC-B1-49）；
   * unavailable：没有 IndexedDB（或浏览器禁用）；error：其他错误（error 只放错误名）
   */
  | { ok: false; reason: 'version_too_new' | 'unavailable' | 'error'; error: string };

export interface OpenCacheOptions {
  /** 默认 planner-v4；测试用别的名字 */
  name?: string;
  /** 默认 DB_VERSION */
  version?: number;
  /** 默认按清单生成（cacheStores()） */
  stores?: readonly StoreDef[];
  /** 默认 cacheMigrations */
  migrations?: readonly CacheMigration[];
  /** 默认 globalThis.indexedDB */
  factory?: IDBFactory;
  /** 升级被别的标签页挡住（blocked）：提示“请关掉其他打开的柠檬记窗口”；挡住的标签页关掉以后 open 会继续 */
  onBlocked?: () => void;
}

/** 收到 versionchange 后最多等多久（先写草稿、跑“关库前”回调）再关库；boot.ts 按它定 blocked 提示的延迟 */
export const VERSION_CLOSE_WAIT_MS = 2000;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('idb_request_failed'));
  });
}

function errName(e: unknown): string {
  return e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException) ? e.name : 'error';
}

function wrap(db: IDBDatabase, name: string, version: number, stores: readonly StoreDef[]): Cache {
  let state: 'open' | 'closing' | 'closed' = 'open';
  let sealed = false;
  const beforeClose = new Set<() => Promise<void> | void>();
  const closedListeners = new Set<(r: CacheCloseReason) => void>();
  const draftStores = new Set([DRAFTS, VAULT_DRAFTS]);

  const finishClose = (reason: CacheCloseReason): void => {
    if (state === 'closed') return;
    state = 'closed';
    db.close();
    for (const l of [...closedListeners]) l(reason);
  };

  db.onversionchange = (ev: { newVersion?: number | null }) => {
    if (state !== 'open') return;
    state = 'closing';
    // newVersion 为 null：别处在删库（别的标签页退出登录，K6 复审 C）——照样先跑“关库前”回调，但按 'deleted' 关，
    // 不走升级的重新载入、不出“有新版本”的提示；由 boot 的 onCacheDeleted 看会话决定回登录页还是重新载入
    const reason: CacheCloseReason = ev.newVersion === null ? 'deleted' : 'versionchange';
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, VERSION_CLOSE_WAIT_MS));
    const flush = Promise.allSettled([...beforeClose].map((f) => Promise.resolve().then(f)));
    void Promise.race([flush, timeout]).then(() => finishClose(reason));
  };

  const tx: Cache['tx'] = async (names, mode, fn, opts) => {
    if (state === 'closed') throw new CacheClosedError();
    if (sealed && mode !== 'readonly' && opts?.bypassSeal !== true) throw new CacheClosedError();
    if (state === 'closing' && mode !== 'readonly' && names.some((n) => !draftStores.has(n))) throw new CacheClosedError();
    const t = db.transaction([...names], mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onabort = () => reject(t.error ?? new Error('idb_tx_aborted'));
      t.onerror = () => undefined;   // 错误会冒泡成 abort，在 onabort 里统一处理
    });
    const api: CacheTx = {
      get: (s, k) => req(t.objectStore(s).get(k)) as Promise<never>,
      getAll: (s) => req(t.objectStore(s).getAll()) as Promise<never>,
      getAllByIndex: (s, i, k) => req(t.objectStore(s).index(i).getAll(k)) as Promise<never>,
      put: async (s, v) => {
        await req(t.objectStore(s).put(v));
      },
      delete: async (s, k) => {
        await req(t.objectStore(s).delete(k));
      },
      clear: async (s) => {
        await req(t.objectStore(s).clear());
      },
    };
    let out: Awaited<ReturnType<typeof fn>>;
    try {
      out = await fn(api);
    } catch (e) {
      try {
        t.abort();
      } catch {
        // 事务已经结束（提交或中止）
      }
      await done.catch(() => undefined);
      throw e;
    }
    await done;
    return out;
  };

  const syncTables = stores.filter((s) => s.kind === 'sync').map((s) => s.name);
  const storeNames = (): string[] => [...db.objectStoreNames];

  return {
    name,
    version,
    stores,
    syncTables,
    isClosed: () => state !== 'open',
    tx,
    getRow: (table, id) => tx([table], 'readonly', (t) => t.get(table, id)),
    allRows: (table) => tx([table], 'readonly', (t) => t.getAll(table)),
    putRows: (table, rows) =>
      tx([table], 'readwrite', async (t) => {
        for (const r of rows) await t.put(table, r);
      }),
    deleteRows: (table, ids) =>
      tx([table], 'readwrite', async (t) => {
        for (const id of ids) await t.delete(table, id);
      }),
    getMeta: async (key) => {
      const rec = await tx([META], 'readonly', (t) => t.get<{ key: string; value: never }>(META, key));
      return rec?.value;
    },
    setMeta: (key, value) => tx([META], 'readwrite', (t) => t.put(META, { key, value })),
    deleteMeta: (key) => tx([META], 'readwrite', (t) => t.delete(META, key)),
    putDraft: (d) => tx([DRAFTS], 'readwrite', (t) => t.put(DRAFTS, d)),
    getDraft: (id) => tx([DRAFTS], 'readonly', (t) => t.get<Draft>(DRAFTS, id)),
    allDrafts: () => tx([DRAFTS], 'readonly', (t) => t.getAll<Draft>(DRAFTS)),
    deleteDraft: (id) => tx([DRAFTS], 'readwrite', (t) => t.delete(DRAFTS, id)),
    clearAll: () => {
      const names = storeNames();
      return tx(
        names,
        'readwrite',
        async (t) => {
          for (const n of names) await t.clear(n);
        },
        { bypassSeal: true },
      );
    },
    storeNames,
    seal: () => {
      sealed = true;
    },
    isSealed: () => sealed,
    onBeforeVersionClose(fn) {
      beforeClose.add(fn);
      return () => {
        beforeClose.delete(fn);
      };
    },
    onClosed(fn) {
      closedListeners.add(fn);
      return () => {
        closedListeners.delete(fn);
      };
    },
    close: () => finishClose('closed'),
  };
}

export type DeleteCacheResult = DeleteDbResult;

/**
 * 按库名删掉整个本机库（会话没了时用：别的标签页退出、冷启动没有会话但库还在；登录页审查）。
 * 实现只有一份：platform/sign-out.ts 的 deleteLocalDb（一开始就起总定时器，waitMs 到了返回 'blocked'，done 标志防重复 resolve；
 * 排在另一个卡住的删库请求后面、什么事件都收不到时也会按时返回，不会让启动永远等着白屏）。删库请求本身留在浏览器里，挡着的关了就删。
 * 调用方先关本页自己的连接（cache.close()，原因 'closed'），否则本页会收到 versionchange → 自动重新载入，形成循环。永远 resolve
 */
export function deleteCacheDb(opts: { factory?: IDBFactory | undefined; name?: string | undefined; waitMs?: number } = {}): Promise<DeleteCacheResult> {
  return deleteLocalDb(opts.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB, opts.name ?? DB_NAME, opts.waitMs);
}

/** 打开本机库：按需建库、升级、跑迁移。永远 resolve，不 reject */
export function openCache(opts: OpenCacheOptions = {}): Promise<OpenCacheResult> {
  const name = opts.name ?? DB_NAME;
  const version = opts.version ?? DB_VERSION;
  const stores = opts.stores ?? cacheStores();
  const migrations = opts.migrations ?? cacheMigrations;
  const factory = opts.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return Promise.resolve({ ok: false, reason: 'unavailable', error: 'no_indexeddb' });

  return new Promise((resolve) => {
    const report: UpgradeReport = { from: 0, to: version, ran: [], failed: null, rebuilt: [] };
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(name, version);
    } catch (e) {
      resolve({ ok: false, reason: 'unavailable', error: errName(e) });
      return;
    }
    r.onupgradeneeded = (ev) => {
      report.from = ev.oldVersion;
      const t = r.transaction;
      if (!t) return;
      runUpgrade(r.result, t, stores, migrations, report);
    };
    r.onblocked = () => opts.onBlocked?.();
    r.onsuccess = () => resolve({ ok: true, cache: wrap(r.result, name, version, stores), upgrade: report });
    r.onerror = (ev) => {
      ev.preventDefault();
      const n = r.error?.name ?? 'error';
      resolve({ ok: false, reason: n === 'VersionError' ? 'version_too_new' : 'error', error: n });
    };
  });
}
