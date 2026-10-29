// 本机库的版本和迁移表（架构 4.1、0.27 第 1 点）
// • indexedDB.open('planner-v4', DB_VERSION)；DB_VERSION 是整数，从 1 开始
// • 清单的 store 结构（store、keyPath、indexes）一变，DB_VERSION 必须加 1，并重新生成 core/cache-schema.lock（CI 核对）
// • 迁移按 {to, up(ctx)} 逐级执行；每一步在升级回调里 try/catch，出错时在同一个 versionchange 事务里
//   删掉并重建所有 rebuildable 的仓（同步仓和 meta），之后整表重拉；outbox、drafts、vault_drafts、pending_actions 不动
// • 不支持降级：旧版打开更高版本的库报 VersionError，由 cache.ts 报给界面，不删库
// 纯 TS：不准 import React 和任何功能（A1）
import type { StoreDef } from './cache-schema.ts';

/** 当前本机库版本。改了 store 结构就加 1，并在 cacheMigrations 末尾加一项 {to: 新版本} */
export const DB_VERSION = 1;

/** 迁移函数拿到的东西 */
export interface MigrationCtx {
  readonly db: IDBDatabase;
  /** 这次升级的 versionchange 事务；直接发请求时，请求的 onerror 要调 fail（否则整个事务会中止、库打不开） */
  readonly tx: IDBTransaction;
  /** 升级前的库版本 */
  readonly from: number;
  /**
   * 读出整个 store、逐行改写：回调返回新值就写回，返回 null 就删掉这一行。
   * 回调抛错、请求失败都按“迁移失败”处理（重建可重拉的仓），不会让库打不开
   */
  transform(store: string, fn: (value: unknown) => unknown): void;
  /** 迁移自己发现数据不对时调用：按“迁移失败”处理 */
  fail(error: unknown): void;
}

/** 一步迁移：从 to - 1 升到 to */
export interface CacheMigration {
  readonly to: number;
  /** 只能同步地排请求，不要 await（versionchange 事务在没有请求时会自动提交） */
  up(ctx: MigrationCtx): void;
}

/**
 * 迁移表。DB_VERSION = 1 是第一版，还没有迁移。
 * 删仓必须由迁移 ctx.db.deleteObjectStore(…) 删（K6 复审 N5）：结构核对不会删多出来的仓；
 * 没删掉的旧仓会留在库里，换账号、退出时 claimCache / clearAll 按库里实际的仓名一起清空
 * 规矩（K6 审查 L9）：不准用 transform 改 rebuildable = false 的仓（outbox、drafts、vault_drafts、pending_actions、owner）——
 * 迁移一失败，这些仓不会被重建，改了一半的数据就留在里面；队列项的格式升级走 core/outbox-migrations.ts（启动时逐项迁移，失败的留着不发）
 * 以后加：{ to: 2, up(ctx) { ctx.transform('events', (row) => …) } }；
 * 要删掉的仓由迁移自己 ctx.db.deleteObjectStore(…)（结构核对只补建缺的仓和索引，不自动删多出来的仓）
 */
export const cacheMigrations: readonly CacheMigration[] = [];

/** 一次打开库时升级的结果（cache.ts 返回给 boot，boot 决定要不要整表重拉） */
export interface UpgradeReport {
  /** 升级前的版本；0 表示这台设备第一次建库 */
  from: number;
  to: number;
  /** 跑过的迁移（to 的列表） */
  ran: number[];
  /** 迁移失败：哪一步、错误名（只记错误名，不记内容） */
  failed: { at: number; error: string } | null;
  /** 因迁移失败被删掉重建的仓 */
  rebuilt: string[];
}

/** 迁移表自查：to 从 2 开始、严格递增、不超过 DB_VERSION、最后一项等于 DB_VERSION */
export function validateMigrations(list: readonly CacheMigration[], dbVersion: number): string | null {
  let prev = 1;
  for (const m of list) {
    if (!Number.isInteger(m.to) || m.to <= prev) return `cache_migration_order:${m.to}`;
    if (m.to > dbVersion) return `cache_migration_beyond_db_version:${m.to}`;
    prev = m.to;
  }
  if (dbVersion > 1 && prev !== dbVersion) return `cache_migration_missing:${dbVersion}`;
  return null;
}

function errorName(e: unknown): string {
  if (e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException)) return e.name || 'Error';
  return 'error';
}

function createStore(db: IDBDatabase, def: StoreDef): void {
  const s = db.createObjectStore(def.name, { keyPath: def.keyPath });
  for (const i of def.indexes) s.createIndex(i.name, i.keyPath, { unique: i.unique === true, multiEntry: i.multiEntry === true });
}

/** 补建缺的仓和索引、删掉没登记的索引（不删多出来的仓，见 cacheMigrations 的注释） */
export function ensureStructure(db: IDBDatabase, tx: IDBTransaction, stores: readonly StoreDef[]): void {
  for (const def of stores) {
    if (!db.objectStoreNames.contains(def.name)) {
      createStore(db, def);
      continue;
    }
    const s = tx.objectStore(def.name);
    const want = new Set(def.indexes.map((i) => i.name));
    for (const name of [...s.indexNames]) if (!want.has(name)) s.deleteIndex(name);
    for (const i of def.indexes) {
      if (!s.indexNames.contains(i.name)) s.createIndex(i.name, i.keyPath, { unique: i.unique === true, multiEntry: i.multiEntry === true });
    }
  }
}

/**
 * 在 onupgradeneeded 里调用（同步）：先补结构，再逐级跑迁移；失败就重建可重拉的仓。
 * report 由调用方传入，异步失败（transform 的请求回调里）也会写进同一个对象
 */
export function runUpgrade(
  db: IDBDatabase,
  tx: IDBTransaction,
  stores: readonly StoreDef[],
  migrations: readonly CacheMigration[],
  report: UpgradeReport,
): void {
  let current = 0;

  const fail = (error: unknown): void => {
    if (report.failed) return;
    report.failed = { at: current, error: errorName(error) };
    for (const def of stores) {
      if (!def.rebuildable) continue;
      if (db.objectStoreNames.contains(def.name)) db.deleteObjectStore(def.name);
      createStore(db, def);
      report.rebuilt.push(def.name);
    }
    ensureStructure(db, tx, stores);
  };

  const ctx: MigrationCtx = {
    db,
    tx,
    from: report.from,
    fail,
    transform(storeName, fn) {
      const s = tx.objectStore(storeName);
      const keyPath = typeof s.keyPath === 'string' ? s.keyPath : null;
      const r = s.getAll();
      r.onerror = (ev) => {
        ev.preventDefault();
        fail(r.error);
      };
      r.onsuccess = () => {
        if (report.failed) return;
        try {
          for (const v of r.result) {
            const next = fn(v);
            let w: IDBRequest;
            if (next === null) {
              if (!keyPath) throw new Error('cache_migration_no_key_path');
              w = s.delete((v as Record<string, IDBValidKey>)[keyPath] as IDBValidKey);
            } else {
              w = s.put(next);
            }
            w.onerror = (ev) => {
              ev.preventDefault();
              fail(w.error);
            };
          }
        } catch (e) {
          fail(e);
        }
      };
    },
  };

  try {
    ensureStructure(db, tx, stores);
  } catch (e) {
    fail(e);
  }
  if (report.from === 0) return;   // 第一次建库：没有旧数据，不跑迁移

  const steps = [...migrations].filter((m) => m.to > report.from && m.to <= report.to).sort((a, b) => a.to - b.to);
  for (const m of steps) {
    if (report.failed) break;
    current = m.to;
    try {
      m.up(ctx);
      report.ran.push(m.to);
    } catch (e) {
      fail(e);
    }
  }
}
