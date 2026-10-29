// write.*（接手清单 K6-ver-new）：本机库不可用（cache === null）时安全降级——读返回空、写不进本机就不写、也不进 outbox，都不抛错；
// 没写进去返回 { ok: false, reason }，和“抵消”（{ ok: true, item: null }）分开，调用方能区分 local_unavailable / closing / switching（复审 W1）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealForExit } from '../account.ts';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../boot.ts';
import { openCache } from '../cache.ts';
import { OutboxRejectError } from '../outbox.ts';
import { clearAllCollections, collection } from '../store.ts';
import { canWriteLocal, localWriteBlocker, write } from '../write.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { todo, uid } from './outbox-fixtures.ts';

const NO_LOCAL = { ok: false, reason: 'local_unavailable' };

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('write.*：本机库不可用时安全降级', () => {
  it('还没启动：local_unavailable，不抛错', async () => {
    expect(canWriteLocal()).toBe(false);
    expect(await write.insert('todos', { ...todo(1), id: uid(1) })).toEqual(NO_LOCAL);
    expect(await write.patch('todos', uid(1), { title: 'x' })).toEqual(NO_LOCAL);
  });

  it('version_too_new（cache === null）：读返回空；写返回 local_unavailable、不抛错、不进 outbox，库原样不动', async () => {
    const { factory, fake } = fakeIndexedDB();
    const hi = await openCache({ factory, version: 5, migrations: [2, 3, 4, 5].map((to) => ({ to, up: () => undefined })) });
    if (hi.ok) hi.cache.close();
    const b = await coldStart(opts(factory));
    expect(b.status).toBe('version_too_new');
    expect(b.cache).toBeNull();
    expect(b.outbox).toBeNull();

    expect(collection('todos').getSnapshot()).toEqual([]);
    expect(collection('todos').get(uid(1))).toBeUndefined();

    expect(canWriteLocal()).toBe(false);
    await expect(write.insert('todos', { ...todo(1), id: uid(1) })).resolves.toEqual(NO_LOCAL);
    await expect(write.patch('todos', uid(1), { title: 'x' })).resolves.toEqual(NO_LOCAL);
    expect(collection('todos').getSnapshot()).toEqual([]);
    expect(fake.dbs.get('planner-v4')?.version).toBe(5);
    expect(fake.dbs.get('planner-v4')?.stores.get('outbox')?.records.size ?? 0).toBe(0);
  });

  it('没有 IndexedDB（unavailable，App 照常渲染）：local_unavailable、不抛错，调用方能提示“没保存上”', async () => {
    const b = await coldStart({ ...opts(undefined as unknown as IDBFactory), cacheOptions: { factory: undefined as unknown as IDBFactory } });
    expect(b.status).toBe('unavailable');
    expect(await write.insert('todos', { ...todo(1), id: uid(1) })).toEqual(NO_LOCAL);
  });

  it('别的标签页在升级本机库（onversionchange 后库关了）：closing，不抛错、不写', async () => {
    const { factory } = fakeIndexedDB();
    const b = await coldStart(opts(factory));
    const other = await openCache({ factory, version: 2, migrations: [{ to: 2, up: () => undefined }] });
    expect(b.cache?.isClosed()).toBe(true);
    expect(localWriteBlocker()).toBe('closing');
    expect(await write.insert('todos', { ...todo(1), id: uid(1) })).toEqual({ ok: false, reason: 'closing' });
    expect(collection('todos').get(uid(1))).toBeUndefined();
    if (other.ok) other.cache.close();
  });

  it('已封存（换账号、退出途中）：switching，不写库', async () => {
    const { factory } = fakeIndexedDB();
    const b = await coldStart(opts(factory));
    sealForExit(b);
    expect(await write.insert('todos', { ...todo(1), id: uid(1) })).toEqual({ ok: false, reason: 'switching' });
    expect(await b.outbox?.list()).toEqual([]);
  });

  it('正常：写进本机、入队、集合马上更新；校验不过照样抛 OutboxRejectError', async () => {
    const { factory } = fakeIndexedDB();
    const b = await coldStart(opts(factory));
    expect(canWriteLocal()).toBe(true);
    const r = await write.insert('todos', { ...todo(1), id: uid(1) }, { remind: true });
    expect(r.ok && r.item).toMatchObject({ op: 'insert', remind: true });
    expect(collection<{ id: string; title?: string }>('todos').get(uid(1))?.title).toBe('待办1');
    expect((await b.outbox?.list())?.length).toBe(1);
    await expect(write.patch('todos', uid(1), { no_such_column: 1 })).rejects.toBeInstanceOf(OutboxRejectError);
  });
});
