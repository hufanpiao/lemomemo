// core/manifest（架构 3.5 第 2 点）：汇总清单；同一张表两个功能登记直接报错
import { describe, expect, it } from 'vitest';
import { allTables, clientWritableOf, syncTables, type Manifest, type ManifestTable } from '../manifest.ts';

const table = (name: string, over: Partial<ManifestTable> = {}): ManifestTable => ({
  name,
  schema: 'public',
  sync: true,
  realtime: true,
  localCache: 'plain',
  clientWritable: ['title'],
  softDelete: true,
  ...over,
});

const list: Manifest[] = [
  { feature: 'calendar', owner: 'feature', tables: [table('events', { clientWritable: ['title', 'date'] })] },
  { feature: 'vault', owner: 'core', tables: [table('vault', { schema: 'private', sync: false, localCache: 'cipher-only' })] },
];

describe('manifest 汇总', () => {
  it('allTables / syncTables', () => {
    expect(allTables(list).map((t) => t.name)).toEqual(['events', 'vault']);
    expect(syncTables(list).map((t) => t.name)).toEqual(['events']);
  });

  it('clientWritableOf：只认 public 的表，没登记的返回 null（outbox 拒收）', () => {
    expect(clientWritableOf('events', list)).toEqual(['title', 'date']);
    expect(clientWritableOf('vault', list)).toBeNull();
    expect(clientWritableOf('nope', list)).toBeNull();
  });

  it('同一张表两个功能登记 → 报错', () => {
    const dup: Manifest[] = [...list, { feature: 'todos', owner: 'feature', tables: [table('events')] }];
    expect(() => allTables(dup)).toThrow('manifest_duplicate_table:public.events:calendar:todos');
  });

  it('桩清单（后端的清单进来以前）为空也能跑', () => {
    expect(allTables()).toEqual([]);
  });
});
