// 本机库（架构 4.1、0.27 第 1 点）：建库、读写、版本迁移、迁移出错、onversionchange、不支持降级
// 用 __tests__/idb-fake.ts 的替身（仓库没有 fake-indexeddb）
import { describe, expect, it, vi } from 'vitest';
import { openCache, type Cache, type CachedRow, type OpenCacheResult } from '../cache.ts';
import type { CacheMigration } from '../cache-migrations.ts';
import { cacheStores, type StoreDef } from '../cache-schema.ts';
import { fakeIndexedDB, flush } from './idb-fake.ts';

function mustOpen(r: OpenCacheResult): Cache {
  if (!r.ok) throw new Error(`open_failed:${r.reason}:${r.error}`);
  return r.cache;
}

const row = (id: string, title: string): CachedRow => ({ id, server: { id, title, rev: 1 }, view: { id, title, rev: 1 } });

describe('建库和读写', () => {
  it('第一次打开：按清单建好所有仓，from = 0，不跑迁移', async () => {
    const { factory, fake } = fakeIndexedDB();
    const r = await openCache({ factory });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upgrade).toMatchObject({ from: 0, to: 1, ran: [], failed: null });
    expect([...(fake.dbs.get('planner-v4')?.stores.keys() ?? [])].sort()).toEqual(cacheStores().map((s) => s.name).sort());
    expect(r.cache.syncTables).toContain('events');
    expect(r.cache.syncTables).not.toContain('outbox');
    r.cache.close();
  });

  it('行、meta、草稿读写；clearAll 清空所有仓', async () => {
    const { factory } = fakeIndexedDB();
    const cache = mustOpen(await openCache({ factory }));
    await cache.putRows('events', [row('a', '会议'), row('b', '吃饭')]);
    expect((await cache.getRow('events', 'a'))?.view?.['title']).toBe('会议');
    expect(await cache.allRows('events')).toHaveLength(2);
    await cache.deleteRows('events', ['b']);
    expect(await cache.allRows('events')).toHaveLength(1);

    await cache.setMeta('schema_v', 7);
    await cache.setMeta('cursor:events', { cursor: '2026-10-29T00:00:00Z', fullSyncAt: 1 });
    expect(await cache.getMeta('schema_v')).toBe(7);
    expect(await cache.getMeta('cursor:events')).toEqual({ cursor: '2026-10-29T00:00:00Z', fullSyncAt: 1 });

    await cache.putDraft({ id: 'd1', kind: 'capture', data: { text: '买牛奶' }, updated_at: 1 });
    expect((await cache.getDraft('d1'))?.data).toEqual({ text: '买牛奶' });

    await cache.clearAll();
    expect(await cache.allRows('events')).toEqual([]);
    expect(await cache.getMeta('schema_v')).toBeUndefined();
    expect(await cache.allDrafts()).toEqual([]);
    cache.close();
  });

  it('事务里抛错：整个事务回滚', async () => {
    const { factory } = fakeIndexedDB();
    const cache = mustOpen(await openCache({ factory }));
    await expect(
      cache.tx(['events', 'outbox'], 'readwrite', async (t) => {
        await t.put('events', row('x', '一半'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await cache.getRow('events', 'x')).toBeUndefined();
    cache.close();
  });

  it('没有 IndexedDB：unavailable', async () => {
    const r = await openCache({ factory: undefined as unknown as IDBFactory, name: 'x' });
    // factory 为 undefined 时退回 globalThis.indexedDB；jsdom 没有 IndexedDB
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unavailable');
  });
});

describe('版本迁移（TC-B1-45、TC-B1-46）', () => {
  const v2stores = (): StoreDef[] => cacheStores();

  async function seedV1(factory: IDBFactory): Promise<void> {
    const c = mustOpen(await openCache({ factory, version: 1 }));
    await c.putRows('events', [row('e1', '旧标题')]);
    await c.putRows('todos', [row('t1', '待办')]);
    await c.setMeta('schema_v', 7);
    await c.tx(['outbox'], 'readwrite', (t) => t.put('outbox', { op_id: 'op1', rec: 'events:e1', table: 'events', id: 'e1' }));
    await c.putDraft({ id: 'd1', kind: 'capture', data: '录到一半', updated_at: 1 });
    await c.tx(['vault_drafts'], 'readwrite', (t) => t.put('vault_drafts', { id: 'v1', cipher: 'xx' }));
    await c.tx(['pending_actions'], 'readwrite', (t) => t.put('pending_actions', { id: 'p1', user_id: 'u1', created_at: 1 }));
    c.close();
  }

  it('DB_VERSION 1 → 2：逐级执行迁移，数据保留', async () => {
    const { factory } = fakeIndexedDB();
    await seedV1(factory);
    const migrations: CacheMigration[] = [
      {
        to: 2,
        up(ctx) {
          ctx.transform('events', (v) => {
            const r = v as CachedRow;
            return { ...r, view: { ...r.view, title: `${String(r.view?.['title'])}（迁移过）` } };
          });
        },
      },
    ];
    const r = await openCache({ factory, version: 2, migrations, stores: v2stores() });
    const c = mustOpen(r);
    if (r.ok) expect(r.upgrade).toMatchObject({ from: 1, to: 2, ran: [2], failed: null, rebuilt: [] });
    expect((await c.getRow('events', 'e1'))?.view?.['title']).toBe('旧标题（迁移过）');
    expect(await c.getRow('todos', 't1')).toBeDefined();
    expect(await c.getMeta('schema_v')).toBe(7);
    c.close();
  });

  it('跨两级（1 → 3）按顺序都跑；transform 返回 null 删掉这一行', async () => {
    const { factory } = fakeIndexedDB();
    await seedV1(factory);
    const order: number[] = [];
    const migrations: CacheMigration[] = [
      { to: 3, up: () => void order.push(3) },
      { to: 2, up: (ctx) => {
        order.push(2);
        ctx.transform('todos', () => null);
      } },
    ];
    const c = mustOpen(await openCache({ factory, version: 3, migrations }));
    expect(order).toEqual([2, 3]);
    expect(await c.allRows('todos')).toEqual([]);
    c.close();
  });

  it('迁移同步抛错：可重拉的仓清空重建，outbox、drafts、vault_drafts、pending_actions 都还在', async () => {
    const { factory } = fakeIndexedDB();
    await seedV1(factory);
    const migrations: CacheMigration[] = [{ to: 2, up: () => { throw new TypeError('bad migration'); } }];
    const r = await openCache({ factory, version: 2, migrations });
    const c = mustOpen(r);
    if (r.ok) {
      expect(r.upgrade.failed).toEqual({ at: 2, error: 'TypeError' });
      expect(r.upgrade.rebuilt).toEqual(expect.arrayContaining(['events', 'todos', 'meta']));
      expect(r.upgrade.rebuilt).not.toContain('outbox');
    }
    expect(await c.allRows('events')).toEqual([]);
    expect(await c.getMeta('schema_v')).toBeUndefined();
    expect(await c.tx(['outbox'], 'readonly', (t) => t.getAll('outbox'))).toHaveLength(1);
    expect(await c.getDraft('d1')).toBeDefined();
    expect(await c.tx(['vault_drafts'], 'readonly', (t) => t.getAll('vault_drafts'))).toHaveLength(1);
    expect(await c.tx(['pending_actions'], 'readonly', (t) => t.getAll('pending_actions'))).toHaveLength(1);
    // 重建后的 outbox 索引还在
    expect(await c.tx(['outbox'], 'readonly', (t) => t.getAllByIndex('outbox', 'rec', 'events:e1'))).toHaveLength(1);
    c.close();
  });

  it('迁移异步出错（transform 回调里抛）：同样重建，库照常能打开', async () => {
    const { factory } = fakeIndexedDB();
    await seedV1(factory);
    const migrations: CacheMigration[] = [{ to: 2, up: (ctx) => ctx.transform('events', () => { throw new RangeError('x'); }) }];
    const r = await openCache({ factory, version: 2, migrations });
    const c = mustOpen(r);
    if (r.ok) expect(r.upgrade.failed?.error).toBe('RangeError');
    expect(await c.allRows('events')).toEqual([]);
    expect(await c.tx(['outbox'], 'readonly', (t) => t.getAll('outbox'))).toHaveLength(1);
    c.close();
  });
});

describe('不支持降级（TC-B1-49）', () => {
  it('库版本比 App 高：version_too_new，不删库', async () => {
    const { factory, fake } = fakeIndexedDB();
    const hi = mustOpen(await openCache({ factory, version: 3, migrations: [{ to: 2, up: () => undefined }, { to: 3, up: () => undefined }] }));
    await hi.putRows('events', [row('e1', '新版写的')]);
    hi.close();
    const r = await openCache({ factory, version: 1 });
    expect(r).toEqual({ ok: false, reason: 'version_too_new', error: 'VersionError' });
    expect(fake.dbs.get('planner-v4')?.version).toBe(3);
    expect(fake.dbs.get('planner-v4')?.stores.get('events')?.records.size).toBe(1);
  });
});

describe('onversionchange（TC-B1-48 的本机库部分）', () => {
  it('别的标签页以更高版本打开：先跑关库前回调（草稿单独提交），再关库、挡写入；新版本打开成功', async () => {
    const { factory } = fakeIndexedDB();
    const a = mustOpen(await openCache({ factory }));
    const closed = vi.fn();
    a.onClosed(closed);
    a.onBeforeVersionClose(async () => {
      await a.putDraft({ id: 'editing', kind: 'note-edit', data: '没保存的正文', updated_at: 2 });
    });
    const b = mustOpen(await openCache({ factory, version: 2, migrations: [{ to: 2, up: () => undefined }] }));
    expect(closed).toHaveBeenCalledWith('versionchange');
    expect(a.isClosed()).toBe(true);
    await expect(a.putRows('events', [row('x', 'y')])).rejects.toThrow('cache_closed');
    expect((await b.getDraft('editing'))?.data).toBe('没保存的正文');
    b.close();
  });

  it('旧标签页一直不关（没监听）：新版本收到 blocked，关掉以后继续', async () => {
    const { factory, fake } = fakeIndexedDB();
    const old = mustOpen(await openCache({ factory }));
    // 模拟“没有监听 onversionchange 的旧版标签页”
    const conn = [...(fake.dbs.get('planner-v4')?.connections ?? [])][0];
    if (conn) conn.onversionchange = null;
    const onBlocked = vi.fn();
    const p = openCache({ factory, version: 2, migrations: [{ to: 2, up: () => undefined }], onBlocked });
    await flush();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    old.close();
    const c = mustOpen(await p);
    expect(c.version).toBe(2);
    c.close();
  });

  it('关库中只准写 drafts', async () => {
    const { factory } = fakeIndexedDB();
    const a = mustOpen(await openCache({ factory }));
    let during: unknown = null;
    a.onBeforeVersionClose(async () => {
      during = await a.putRows('events', [row('x', 'y')]).catch((e: unknown) => e);
      await a.putDraft({ id: 'ok', kind: 'k', data: 1, updated_at: 1 });
    });
    const b = mustOpen(await openCache({ factory, version: 2, migrations: [{ to: 2, up: () => undefined }] }));
    expect((during as Error).message).toBe('cache_closed');
    expect(await b.getDraft('ok')).toBeDefined();
    b.close();
  });
});
