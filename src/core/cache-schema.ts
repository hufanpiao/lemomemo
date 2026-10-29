// 本机库的 store 结构（架构 4.1、0.27 第 1 点）：同步仓按数据清单生成，不手写表清单；本机专用的几个仓写在这里
// 结构（store 名、keyPath、indexes）一变，core/cache-migrations.ts 的 DB_VERSION 必须加 1：
//   schemaHash() 的结果写在 core/cache-schema.lock，core/__tests__/cache-schema.test.ts 在 CI 里核对（漏改就失败）
// 纯 TS：不准 import React 和任何功能（A1）
import type { Manifest } from './manifest.ts';
import { syncTables } from './manifest.ts';

/** 一个索引；keyPath 只用字符串（本机库没有复合索引的需要） */
export interface IndexDef {
  readonly name: string;
  readonly keyPath: string;
  readonly unique?: boolean;
  readonly multiEntry?: boolean;
}

/** 一个 store 的结构 */
export interface StoreDef {
  readonly name: string;
  readonly keyPath: string;
  readonly indexes: readonly IndexDef[];
  /**
   * 迁移出错时能不能删掉重建（之后整表重拉）。
   * false 的（outbox、drafts、vault_drafts、pending_actions、owner）里是还没上传、拉不回来的内容，任何情况下迁移都不动它们
   */
  readonly rebuildable: boolean;
  /** 'sync'：按清单建的同步仓（每行 {id, server, view}）；'local'：本机专用 */
  readonly kind: 'sync' | 'local';
}

/** 本机专用仓的名字 */
export const META = 'meta';
export const OUTBOX = 'outbox';
export const DRAFTS = 'drafts';
export const VAULT_DRAFTS = 'vault_drafts';
export const PENDING_ACTIONS = 'pending_actions';
export const OWNER = 'owner';

/** 本机专用的仓（不在数据清单里） */
export const LOCAL_STORES: readonly StoreDef[] = [
  // 各表的同步游标、上次整表同步时间、config、profile、待补拉 id……（键见 cache.ts 的 MetaMap）
  // 能重拉：迁移失败时随同步仓一起清空，之后整表重拉
  { name: META, keyPath: 'key', indexes: [], rebuildable: true, kind: 'local' },
  // 离线写入队列（4.2）；rec 索引 = `${table}:${id}`，同一条记录的几项一起找
  { name: OUTBOX, keyPath: 'op_id', indexes: [{ name: 'rec', keyPath: 'rec' }], rebuildable: false, kind: 'local' },
  // 录音、编辑中的草稿（0.27：收到 onversionchange 时关库前先单独提交）
  { name: DRAFTS, keyPath: 'id', indexes: [], rebuildable: false, kind: 'local' },
  // 隐私记的草稿：只存密文（隐私记的明文不进 IndexedDB，4.1），B5 才用
  { name: VAULT_DRAFTS, keyPath: 'id', indexes: [], rebuildable: false, kind: 'local' },
  // SW 记下的通知按键（0.29 续第 107 条），启动时转进 outbox
  { name: PENDING_ACTIONS, keyPath: 'id', indexes: [], rebuildable: false, kind: 'local' },
  // 10-29 加 owner 仓时 K6 的本机库还没提交、没上线，没有旧库，故未升 DB_VERSION（只重新生成了锁文件）
  // 这个库归谁（{key: 'user_id', value}，core/account.ts 读写；K6 审查 M4）：
  // 不放 meta，因为 meta 迁移失败会重建，user_id 丢了以后 outbox、草稿还在，可能用别人的令牌发出去
  { name: OWNER, keyPath: 'key', indexes: [], rebuildable: false, kind: 'local' },
];

/** 按清单生成的同步仓：sync: true 的每张表一个，主键 id，行存 {id, server, view, ro?} */
export function syncStores(list?: readonly Manifest[]): StoreDef[] {
  return syncTables(list).map((t) => ({ name: t.name, keyPath: 'id', indexes: [], rebuildable: t.rebuildable, kind: 'sync' as const }));
}

/** 本机库的全部 store（同步仓 + 本机专用仓）；同名直接报错 */
export function cacheStores(list?: readonly Manifest[]): StoreDef[] {
  const all = [...syncStores(list), ...LOCAL_STORES];
  const seen = new Set<string>();
  for (const s of all) {
    if (seen.has(s.name)) throw new Error(`cache_store_duplicate:${s.name}`);
    seen.add(s.name);
  }
  return all;
}

/** 参与哈希的结构：{store, keyPath, indexes}，按名字排好序（rebuildable、kind 不影响库结构，不算） */
export function canonicalSchema(stores: readonly StoreDef[]): string {
  const norm = [...stores]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((s) => ({
      store: s.name,
      keyPath: s.keyPath,
      indexes: [...s.indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((i) => ({ name: i.name, keyPath: i.keyPath, unique: i.unique === true, multiEntry: i.multiEntry === true })),
    }));
  return JSON.stringify(norm);
}

/** 结构哈希（cyrb53，16 位十六进制）：只用来发现“结构变了”，不是安全用途 */
export function schemaHash(stores: readonly StoreDef[]): string {
  const str = canonicalSchema(stores);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h2) + hex(h1);
}

/** core/cache-schema.lock 的内容 */
export interface SchemaLock {
  db_version: number;
  hash: string;
}

/**
 * 核对锁文件（TC-B1-47）：返回 null 表示一致，否则返回错误码
 * - cache_schema_changed_without_version_bump：结构变了而 DB_VERSION 没加 1
 * - cache_schema_lock_stale：DB_VERSION 加了但锁文件没更新（重新生成锁文件即可）
 * - cache_schema_version_went_back：DB_VERSION 比锁文件小（不支持降级）
 */
export function checkSchemaLock(stores: readonly StoreDef[], dbVersion: number, lock: SchemaLock): string | null {
  const hash = schemaHash(stores);
  if (dbVersion < lock.db_version) return 'cache_schema_version_went_back';
  if (dbVersion === lock.db_version) return hash === lock.hash ? null : 'cache_schema_changed_without_version_bump';
  return 'cache_schema_lock_stale';
}
