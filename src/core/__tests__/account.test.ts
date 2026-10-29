// 换账号就清空本机（架构 4.1、0.38 第 17 条；K6 审查 M2～M5）：库归属记在 owner 仓、比对和清空在同一个事务里、
// 清库失败即关（不渲染缓存）、迁移失败（meta 被重建）以后换账号照样清掉旧账号的 outbox、迁移失败后按 outbox 重建 view
// 事件时机（SIGNED_IN、TOKEN_REFRESHED、storage、挂上后再比一次）见 account-watch.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheOwner, claimCache, ensureAccount } from '../account.ts';
import { coldStart, getBoot, resetBootForTest } from '../boot.ts';
import { createOutbox } from '../outbox.ts';
import { clearAllCollections, collection } from '../store.ts';
import { count, freshCache, seedA } from './account-fixtures.ts';
import { FakeObjectStore } from './idb-fake-tx.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { todo, uid } from './outbox-fixtures.ts';

const bootDeps = {
  appVersion: '4.0.0',
  listen426: false,
  clearCacheStorage: () => Promise.resolve(),
  upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
};

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('ensureAccount / claimCache', () => {
  it('同一个账号：什么都不动', async () => {
    const cache = await freshCache();
    await seedA(cache);
    const clear = vi.fn(() => Promise.resolve());
    expect(await ensureAccount(cache, 'A', { clearCacheStorage: clear })).toBe(false);
    expect(await count(cache)).toBe(4);
    expect(clear).not.toHaveBeenCalled();
  });

  it('换了账号：清空整库（旧账号的 outbox、pending_actions、草稿直接丢）、集合、运行时缓存，owner 记成新账号', async () => {
    const cache = await freshCache();
    await seedA(cache);
    const clear = vi.fn(() => Promise.resolve());
    expect(await ensureAccount(cache, 'B', { clearCacheStorage: clear })).toBe(true);
    expect(await count(cache)).toBe(0);
    expect(collection('todos').getSnapshot()).toEqual([]);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(await cacheOwner(cache)).toBe('B');
  });

  it('owner 没有记录：库里的东西归属不明，一律清空再记下（不清 Cache Storage、不算换账号）', async () => {
    const cache = await freshCache();
    await cache.tx(['outbox'], 'readwrite', (t) => t.put('outbox', { op_id: 'o', rec: 'todos:t', seq: 1 }));
    const clear = vi.fn(() => Promise.resolve());
    expect(await claimCache(cache, 'B')).toBe('first');
    expect(await cache.tx(['outbox'], 'readonly', (t) => t.getAll('outbox'))).toHaveLength(0);
    expect(await ensureAccount(cache, 'B', { clearCacheStorage: clear })).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(await cacheOwner(cache)).toBe('B');
  });

  it('原子：清空中途出错 → 整个事务回滚（A 的数据和 owner 都还在），ensureAccount 抛错', async () => {
    const cache = await freshCache();
    await seedA(cache);
    const real = FakeObjectStore.prototype.clear;
    let n = 0;
    vi.spyOn(FakeObjectStore.prototype, 'clear').mockImplementation(function (this: FakeObjectStore) {
      if (++n === 3) throw new DOMException('disk', 'QuotaExceededError');
      return real.call(this);
    });
    await expect(ensureAccount(cache, 'B', { clearCacheStorage: () => Promise.resolve() })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await count(cache)).toBe(4);
    expect(await cacheOwner(cache)).toBe('A');
  });
});

describe('冷启动时换账号（M3、M4、M5）', () => {
  it('M3：启动时清库抛错 → 关库、集合清空、按 unavailable 返回，不渲染缓存', async () => {
    const { factory } = fakeIndexedDB();
    const seedCache = await freshCache(factory);
    await seedA(seedCache);
    seedCache.close();
    collection('todos').upsert([{ id: 'stale' }]);
    vi.spyOn(FakeObjectStore.prototype, 'clear').mockImplementation(() => {
      throw new DOMException('disk', 'QuotaExceededError');
    });
    const b = await coldStart({ ...bootDeps, userId: 'B', cacheOptions: { factory } });
    expect(b.status).toBe('unavailable');
    expect(b.cache).toBeNull();
    expect(b.outbox).toBeNull();
    expect(b.error).toBe('QuotaExceededError');
    expect(collection('todos').getSnapshot()).toEqual([]);
    vi.restoreAllMocks();
    // 库没被半截清掉：A 的东西原样在（下次以 A 打开照常用；以 B 打开会再清一次）
    const again = await freshCache(factory);
    expect(await cacheOwner(again)).toBe('A');
    expect(await count(again)).toBe(4);
    again.close();
  });

  it('M4：迁移失败（meta 被重建）以后以 B 登录：owner 不在 meta 里、没丢，A 的 outbox 和草稿照样清掉，不会用 B 的令牌发出去', async () => {
    const { factory } = fakeIndexedDB();
    const seedCache = await freshCache(factory);
    await seedA(seedCache);
    seedCache.close();
    const b = await coldStart({
      ...bootDeps,
      userId: 'B',
      cacheOptions: { factory, version: 2, migrations: [{ to: 2, up: (ctx) => ctx.fail(new Error('bad')) }] },
    });
    expect(b.status).toBe('ready');
    expect(b.upgradeReport?.failed).not.toBeNull();
    expect(b.upgradeReport?.rebuilt).toContain('meta');
    expect(b.upgradeReport?.rebuilt).not.toContain('owner');
    expect(b.switchedUser).toBe(true);
    expect(await b.outbox?.list()).toEqual([]);
    expect(await b.cache?.allDrafts()).toEqual([]);
    expect(b.cache ? await cacheOwner(b.cache) : null).toBe('B');
  });

  it('M5：迁移失败、同一个人：同步仓重建成空的，outbox 里还没发出的 insert 照样重建 view、灌进集合', async () => {
    const { factory } = fakeIndexedDB();
    const seedCache = await freshCache(factory);
    await claimCache(seedCache, 'A');
    const ob = createOutbox(seedCache, { appVersion: '4.0.0' });
    await ob.boot();
    await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    seedCache.close();
    clearAllCollections();
    const b = await coldStart({
      ...bootDeps,
      userId: 'A',
      cacheOptions: { factory, version: 2, migrations: [{ to: 2, up: (ctx) => ctx.fail(new Error('bad')) }] },
    });
    expect(b.upgradeReport?.rebuilt).toContain('todos');
    expect((await b.outbox?.list())?.length).toBe(1);
    expect((await b.cache?.getRow('todos', uid(1)))?.view?.['title']).toBe('待办1');
    expect(collection<{ id: string; title?: string }>('todos').get(uid(1))?.title).toBe('待办1');
  });
});
