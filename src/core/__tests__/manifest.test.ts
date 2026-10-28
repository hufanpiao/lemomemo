// core/manifest（架构 3.5 第 2 点）：汇总清单；同一张表两个功能登记直接报错
import { describe, expect, it } from 'vitest';
import { defineManifest, type ManifestTableInput } from '../../../shared/schema/manifest.ts';
import { allTables, clientWritableOf, syncTables, tombstoneTables, type Manifest } from '../manifest.ts';

const table = (name: string, over: Partial<ManifestTableInput> = {}): ManifestTableInput => ({
  name,
  schema: 'public',
  sync: true,
  realtime: true,
  localCache: 'plain',
  clientWritable: ['title'],
  softDelete: true,
  backup: 'json',
  export: 'json',
  onAccountDelete: 'cascade',
  userLookup: { by: 'column', col: 'user_id' },
  ...over,
});

const list: Manifest[] = [
  defineManifest({ feature: 'calendar', owner: 'feature', tables: [table('events', { clientWritable: ['title', 'date'] })] }),
  defineManifest({
    feature: 'vault',
    owner: 'core',
    tables: [table('vault', { schema: 'private', sync: false, localCache: 'cipher-only' })],
  }),
  defineManifest({
    feature: 'core',
    owner: 'core',
    tables: [table('tombstones', { sync: 'tombstone', localCache: 'none', clientWritable: [], softDelete: false })],
  }),
];

describe('manifest 汇总', () => {
  it('allTables / syncTables：墓碑表不建本机仓，不算进 syncTables', () => {
    expect(allTables(list).map((t) => t.name)).toEqual(['events', 'vault', 'tombstones']);
    expect(syncTables(list).map((t) => t.name)).toEqual(['events']);
    expect(tombstoneTables(list).map((t) => t.name)).toEqual(['tombstones']);
  });

  it('clientWritableOf：只认 public 的表，没登记的返回 null（outbox 拒收）', () => {
    expect(clientWritableOf('events', list)).toEqual(['title', 'date']);
    expect(clientWritableOf('vault', list)).toBeNull();
    expect(clientWritableOf('nope', list)).toBeNull();
  });

  it('同一张表两个功能登记 → 报错', () => {
    const dup: Manifest[] = [...list, defineManifest({ feature: 'todos', owner: 'feature', tables: [table('events')] })];
    expect(() => allTables(dup)).toThrow('manifest_duplicate_table:public.events:calendar:todos');
  });

  it('默认用后端的清单（shared/manifests）：表不重复、墓碑表只有 tombstones', () => {
    const names = allTables().map((t) => `${t.schema}.${t.name}`);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('public.events');
    expect(names).toContain('public.todos');
    expect(tombstoneTables().map((t) => t.name)).toEqual(['tombstones']);
    expect(syncTables().some((t) => t.name === 'tombstones')).toBe(false);
    expect(clientWritableOf('todos')).toContain('title');
  });
});
