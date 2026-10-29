// 离线冷启动（架构 4.1、0.27 第 1、4 点）：TC-B1-50（按缓存挂入口）、换账号清库、过期软删除、整表重拉、426 暂停延续、VersionError
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheOwner, claimCache } from '../account.ts';
import { deleteCacheDb, openCache } from '../cache.ts';
import { applyFreshConfig, coldStart, enabledFlags, getBoot, LOCAL_PURGE_AFTER_MS, resetBootForTest, type BootOptions } from '../boot.ts';
import { clearAllCollections, collection } from '../store.ts';
import { fakeIndexedDB } from './idb-fake.ts';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function opts(factory: IDBFactory, over: Partial<BootOptions> = {}): BootOptions {
  return {
    userId: 'u1',
    appVersion: '4.0.0',
    now: () => NOW,
    cacheOptions: { factory },
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    ...over,
  };
}

async function seed(factory: IDBFactory, fn: (c: Awaited<ReturnType<typeof openCache>> & { ok: true }) => Promise<void>): Promise<void> {
  const r = await openCache({ factory });
  if (!r.ok) throw new Error('open');
  await fn(r);
  r.cache.close();
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('离线冷启动', () => {
  it('TC-B1-50：meta 有上次的 config、profile；features.note.on = false 而本人在 beta_features 里 → 离线也挂随手记入口', async () => {
    const { factory } = fakeIndexedDB();
    await seed(factory, async ({ cache }) => {
      await claimCache(cache, 'u1');
      await cache.setMeta('config', {
        min_client_version: '4.0.0',
        features: { event: { on: true }, todo: { on: true }, note: { on: false }, anniv: { on: false } },
      });
      await cache.setMeta('profile', { id: 'u1', beta_features: ['note'] });
    });
    const b = await coldStart(opts(factory));
    expect(b.status).toBe('ready');
    expect([...(b.flags ?? [])].sort()).toEqual(['event', 'note', 'todo']);
    expect(b.upgrade.getState().syncBlocked).toBeNull();
    expect(getBoot()).toBe(b);

    // 联网切到前台后整行刷新
    const flags = await applyFreshConfig(b, { profile: { id: 'u1', beta_features: [] } });
    expect(flags?.has('note')).toBe(false);
    expect((await b.cache?.getMeta('profile'))?.beta_features).toEqual([]);
  });

  it('没有缓存的 config（第一次）：flags 为 null，入口按默认全挂', async () => {
    const { factory } = fakeIndexedDB();
    const b = await coldStart(opts(factory));
    expect(b.flags).toBeNull();
    expect(enabledFlags(null, null, '4.0.0')).toBeNull();
  });

  it('先用缓存渲染：各同步仓的 view 灌进集合；过期 30 天的软删除行清掉（队列里还有项的不动）', async () => {
    const { factory } = fakeIndexedDB();
    await seed(factory, async ({ cache }) => {
      await claimCache(cache, 'u1');
      const old = NOW - 31 * DAY;
      await cache.putRows('events', [
        { id: 'e1', server: { id: 'e1', title: '会议', rev: 1 }, view: { id: 'e1', title: '会议（本机改过）', rev: 1 } },
        { id: 'e2', server: { id: 'e2', rev: 1, deleted_at: old }, view: { id: 'e2', rev: 1, deleted_at: old } },
        { id: 'e3', server: { id: 'e3', rev: 1, deleted_at: old }, view: { id: 'e3', rev: 1, deleted_at: null } },
        { id: 'e4', server: { id: 'e4', rev: 1, deleted_at: NOW - 29 * DAY }, view: { id: 'e4', rev: 1, deleted_at: NOW - 29 * DAY } },
      ]);
      await cache.tx(['outbox'], 'readwrite', (t) =>
        t.put('outbox', { op_id: 'o', rec: 'events:e3', table: 'events', id: 'e3', op: 'patch', data: { deleted_at: null }, base_rev: 1,
          own_revs: [], client_ts: 0, tries: 0, next_at: 0, state: 'pending', v: 1, app: '4.0.0', seq: 1, remind: false, deps: [], error: null }),
      );
    });
    const b = await coldStart(opts(factory));
    expect(b.purged).toBe(1);
    const ids = collection('events').getSnapshot().map((r) => r.id).sort();
    expect(ids).toEqual(['e1', 'e3', 'e4']);
    expect(collection<{ id: string; title?: string }>('events').get('e1')?.title).toBe('会议（本机改过）');
    expect(LOCAL_PURGE_AFTER_MS).toBe(30 * DAY);
  });

  it('换账号（0.38 第 17 条，启动时）：读写任何东西之前整库清空（含 outbox），清 Cache Storage，整表重拉', async () => {
    const { factory } = fakeIndexedDB();
    const clearCaches = vi.fn(() => Promise.resolve());
    await seed(factory, async ({ cache }) => {
      await claimCache(cache, 'old');
      await cache.putRows('todos', [{ id: 't', server: null, view: { id: 't' } }]);
      await cache.tx(['outbox'], 'readwrite', (t) => t.put('outbox', { op_id: 'o', rec: 'todos:t', seq: 1 }));
    });
    const b = await coldStart(opts(factory, { userId: 'u2', clearCacheStorage: clearCaches }));
    expect(b.switchedUser).toBe(true);
    expect(clearCaches).toHaveBeenCalledTimes(1);
    expect(b.fullResync.length).toBe(9);
    expect(await b.cache?.allRows('todos')).toEqual([]);
    expect(await b.outbox?.list()).toEqual([]);
    expect(b.cache ? await cacheOwner(b.cache) : null).toBe('u2');
    expect(collection('todos').getSnapshot()).toEqual([]);
  });

  it('没登录：返回 signed_out，不打开、不建本机库', async () => {
    const { factory, fake } = fakeIndexedDB();
    const b = await coldStart(opts(factory, { userId: null }));
    expect(b.status).toBe('signed_out');
    expect(b.cache).toBeNull();
    expect(fake.dbs.size).toBe(0);
  });

  it('别的标签页按库名删本机库：调 onCacheDeleted；不走升级的重新载入、不出“有新版本”的提示', async () => {
    const { factory, fake } = fakeIndexedDB();
    const onCacheDeleted = vi.fn();
    const reload = vi.fn();
    const b = await coldStart({
      ...opts(factory),
      onCacheDeleted,
      upgradeDeps: { reload, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
    });
    const del = fake.deleteDatabase('planner-v4');
    await new Promise<void>((r) => (del.onsuccess = () => r()));
    expect(onCacheDeleted).toHaveBeenCalledTimes(1);
    expect(b.cache?.isClosed()).toBe(true);
    expect(b.upgrade.getState().cache).toBe('ok');
    expect(reload).not.toHaveBeenCalled();
  });

  it('没登录、删库请求排在别的卡住的删库后面（永远不触发任何事件）：3 秒后按 blocked 返回，照样走到 signed_out，不会永远等着白屏', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stuck = { deleteDatabase: () => ({}) } as unknown as IDBFactory;
      expect(await Promise.race([deleteCacheDb({ factory: stuck, waitMs: 10 }), vi.advanceTimersByTimeAsync(10).then(() => 'late')])).toBe('blocked');
      let done = false;
      const p = coldStart(opts(stuck, { userId: null })).then((b) => {
        done = true;
        return b;
      });
      await vi.advanceTimersByTimeAsync(2999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).status).toBe('signed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('没登录但库还在（别的标签页退出时本页没来得及清）：按库名删掉，不留上一个账号的数据', async () => {
    const { factory, fake } = fakeIndexedDB();
    const a = await coldStart(opts(factory));
    a.cache?.close();
    resetBootForTest();
    expect(fake.dbs.has('planner-v4')).toBe(true);
    const b = await coldStart(opts(factory, { userId: null }));
    expect(b.status).toBe('signed_out');
    expect(fake.dbs.has('planner-v4')).toBe(false);
  });

  it('TC-B1-40：rows.ts 的 SCHEMA_V 变了 → 所有同步表整表重拉；K7 的待补拉 id 带出来', async () => {
    const { factory } = fakeIndexedDB();
    await seed(factory, async ({ cache }) => {
      await claimCache(cache, 'u1');
      await cache.setMeta('schema_v', 1);
      await cache.setMeta('refetch:todos', ['t9']);
    });
    const b = await coldStart(opts(factory, { schemaV: 2 }));
    expect([...b.fullResync].sort()).toEqual([...(b.cache?.syncTables ?? [])].sort());
    expect(b.fullResync.length).toBe(9);
    expect(b.refetch).toEqual({ todos: ['t9'] });
  });

  it('本机库迁移失败：整表重拉', async () => {
    const { factory } = fakeIndexedDB();
    await seed(factory, async ({ cache }) => void (await claimCache(cache, 'u1')));
    const b = await coldStart(
      opts(factory, { cacheOptions: { factory, version: 2, migrations: [{ to: 2, up: () => { throw new Error('x'); } }] } }),
    );
    expect(b.upgradeReport?.failed).not.toBeNull();
    expect(b.fullResync.length).toBe(9);
  });

  it('上次 426 暂停、同一版本重启：仍挡同步（source = queue）；横幅不用联网就能出', async () => {
    const { factory } = fakeIndexedDB();
    await seed(factory, async ({ cache }) => {
      await claimCache(cache, 'u1');
      await cache.setMeta('outbox_pause', { reason: 'upgrade', min: '4.1.0', app: '4.0.0', at: 1 });
    });
    const b = await coldStart(opts(factory));
    expect(b.upgrade.getState().syncBlocked).toEqual({ min: '4.1.0', source: 'queue' });
    expect(await b.outbox?.next()).toBeNull();
  });

  it('缓存的 min_client_version 比本机高：挡同步（source = config）', async () => {
    const { factory } = fakeIndexedDB();
    await seed(factory, async ({ cache }) => {
      await claimCache(cache, 'u1');
      await cache.setMeta('config', { min_client_version: '4.1.0' });
    });
    const b = await coldStart(opts(factory));
    expect(b.upgrade.getState().syncBlocked).toEqual({ min: '4.1.0', source: 'config' });
  });

  it('TC-B1-49：本机库来自更新的版本 → version_too_new，整屏提示的状态，不删库', async () => {
    const { factory, fake } = fakeIndexedDB();
    const hi = await openCache({ factory, version: 5, migrations: [2, 3, 4, 5].map((to) => ({ to, up: () => undefined })) });
    if (hi.ok) hi.cache.close();
    const b = await coldStart(opts(factory));
    expect(b.status).toBe('version_too_new');
    expect(b.upgrade.getState().cache).toBe('too_new');
    expect(fake.dbs.get('planner-v4')?.version).toBe(5);
  });

  it('别的标签页升级本机库：本页关库，空闲时自动重新载入', async () => {
    const { factory } = fakeIndexedDB();
    const reload = vi.fn();
    const b = await coldStart(opts(factory, { upgradeDeps: { reload, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } } }));
    const other = await openCache({ factory, version: 2, migrations: [{ to: 2, up: () => undefined }] });
    expect(other.ok).toBe(true);
    expect(b.cache?.isClosed()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    if (other.ok) other.cache.close();
  });
});
