// 本机库的结构（架构 4.1、0.27 第 1 点）：同步仓按清单生成；结构变了 DB_VERSION 必须加 1（TC-B1-33、TC-B1-47）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheMigrations, DB_VERSION, validateMigrations } from '../cache-migrations.ts';
import {
  cacheStores,
  canonicalSchema,
  checkSchemaLock,
  LOCAL_STORES,
  schemaHash,
  syncStores,
  type SchemaLock,
  type StoreDef,
} from '../cache-schema.ts';

const lock = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'cache-schema.lock'), 'utf8')) as SchemaLock;

describe('同步仓按清单生成（TC-B1-33 的本机库部分）', () => {
  it('正好是 P-22 定的 9 张表', () => {
    expect(syncStores().map((s) => s.name).sort()).toEqual(
      ['anniversaries', 'categories', 'devices', 'events', 'note_files', 'note_images', 'notes', 'settings', 'todos'].sort(),
    );
  });

  it('profiles、app_config、api_tokens、applied_ops、logs、tombstones 不建同步仓', () => {
    const names = cacheStores().map((s) => s.name);
    for (const t of ['profiles', 'app_config', 'api_tokens', 'applied_ops', 'logs', 'tombstones']) expect(names).not.toContain(t);
  });

  it('本机专用仓：meta 能重拉；outbox、drafts、vault_drafts、pending_actions 不能重拉', () => {
    const by = new Map(LOCAL_STORES.map((s) => [s.name, s]));
    expect(by.get('meta')?.rebuildable).toBe(true);
    for (const n of ['outbox', 'drafts', 'vault_drafts', 'pending_actions']) expect(by.get(n)?.rebuildable).toBe(false);
  });
});

describe('cache-schema.lock（TC-B1-47）', () => {
  it('锁文件和当前结构、DB_VERSION 一致（不一致：结构改了就把 DB_VERSION 加 1 并重新生成锁文件）', () => {
    const stores = cacheStores();
    expect({ db_version: DB_VERSION, hash: schemaHash(stores) }).toEqual(lock);
    expect(checkSchemaLock(stores, DB_VERSION, lock)).toBeNull();
  });

  it('违规样例：改了一个仓的 indexes 而 DB_VERSION 没变 → 失败', () => {
    const stores = cacheStores().map((s): StoreDef =>
      s.name === 'events' ? { ...s, indexes: [{ name: 'by_date', keyPath: 'view.date' }] } : s,
    );
    expect(checkSchemaLock(stores, lock.db_version, lock)).toBe('cache_schema_changed_without_version_bump');
  });

  it('违规样例：加了一个仓而 DB_VERSION 没变 → 失败；加了 1 但锁文件没更新 → 提示重新生成', () => {
    const stores: StoreDef[] = [...cacheStores(), { name: 'habits', keyPath: 'id', indexes: [], rebuildable: true, kind: 'sync' }];
    expect(checkSchemaLock(stores, lock.db_version, lock)).toBe('cache_schema_changed_without_version_bump');
    expect(checkSchemaLock(stores, lock.db_version + 1, lock)).toBe('cache_schema_lock_stale');
    expect(checkSchemaLock(stores, lock.db_version - 1, lock)).toBe('cache_schema_version_went_back');
  });

  it('只改 rebuildable 不算结构变化；仓的顺序不影响哈希', () => {
    const a = cacheStores();
    const b = [...a].reverse().map((s) => ({ ...s, rebuildable: !s.rebuildable }));
    expect(canonicalSchema(b)).toBe(canonicalSchema(a));
    expect(schemaHash(b)).toBe(schemaHash(a));
  });
});

describe('迁移表自查', () => {
  it('当前迁移表合格', () => {
    expect(validateMigrations(cacheMigrations, DB_VERSION)).toBeNull();
  });

  it('乱序、越过 DB_VERSION、漏掉最后一步都报出来', () => {
    const up = (): void => undefined;
    expect(validateMigrations([{ to: 3, up }, { to: 2, up }], 3)).toBe('cache_migration_order:2');
    expect(validateMigrations([{ to: 2, up }, { to: 3, up }], 2)).toBe('cache_migration_beyond_db_version:3');
    expect(validateMigrations([{ to: 2, up }], 3)).toBe('cache_migration_missing:3');
  });
});
