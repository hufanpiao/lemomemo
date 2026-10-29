// 本页退出登录给 K9 用的两个导出：sealForExit（同步设闸，和换账号的 closeGate 同一份代码）、localUnsentCount（还没上传的条数）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealForExit } from '../account.ts';
import { coldStart, getBoot, localUnsentCount, resetBootForTest, type BootResult } from '../boot.ts';
import { CacheClosedError } from '../cache.ts';
import { OutboxRejectError } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { seed, todo, uid } from './outbox-fixtures.ts';

async function boot(): Promise<BootResult> {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('sealForExit', () => {
  it('同步设闸：switching、outbox 暂停、库封存；之后 ack、fail、enqueue 都不再写库；clearAll 照样能清', async () => {
    const b = await boot();
    const cache = b.cache;
    const outbox = b.outbox;
    if (!cache || !outbox) throw new Error('boot');
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改' } });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    const a = await outbox.next();
    if (!a) throw new Error('next');
    const before = JSON.stringify(await outbox.list());

    sealForExit(b);
    expect(b.switching).toBe(true);
    expect(outbox.isSuspended()).toBe(true);
    expect(cache.isSealed()).toBe(true);

    await outbox.ack(a.op_id, { status: 'ok', rev: 6, prev_rev: 5 });
    await outbox.fail(a.op_id, { status: 400 });
    await outbox.fail(a.op_id, { network: true });
    await expect(outbox.enqueue({ table: 'todos', id: uid(3), op: 'insert', data: todo(3) })).rejects.toBeInstanceOf(OutboxRejectError);
    await expect(cache.setMeta('schema_v', 9)).rejects.toBeInstanceOf(CacheClosedError);
    expect(JSON.stringify(await outbox.list())).toBe(before);
    expect((await cache.getRow('todos', uid(1)))?.server?.['rev']).toBe(5);

    await cache.clearAll();
    expect(await outbox.list()).toEqual([]);
  });
});

describe('localUnsentCount', () => {
  it('数 outbox 全部项（待发、正在发、发送失败）+ drafts + vault_drafts + pending_actions', async () => {
    const b = await boot();
    const cache = b.cache;
    const outbox = b.outbox;
    if (!cache || !outbox) throw new Error('boot');
    expect(await localUnsentCount()).toBe(0);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    await outbox.enqueue({ table: 'todos', id: uid(3), op: 'insert', data: todo(3) });
    const first = await outbox.next();
    await outbox.fail(first?.op_id ?? '', { status: 400 });   // 1 条发送失败
    await outbox.next();                                       // 1 条正在发
    await cache.putDraft({ id: 'd', kind: 'capture', data: 1, updated_at: 1 });
    await cache.tx(['vault_drafts', 'pending_actions'], 'readwrite', async (t) => {
      await t.put('vault_drafts', { id: 'v' });
      await t.put('pending_actions', { id: 'p', user_id: 'A', created_at: 1 });
    });
    expect(await localUnsentCount()).toBe(6);
    expect(outbox.getStatus()).toMatchObject({ pending: 2, failed: 1 });   // 先 refresh 过
    expect(await localUnsentCount(b)).toBe(6);
  });

  it('数不出来返回 null：还没启动、outbox 为 null（库打不开）、已封存、已关库、读失败', async () => {
    expect(await localUnsentCount()).toBeNull();

    const sealed = await boot();
    sealForExit(sealed);
    expect(await localUnsentCount()).toBeNull();
    sealed.cache?.close();
    resetBootForTest();

    const closed = await boot();
    closed.cache?.close();
    expect(await localUnsentCount()).toBeNull();
    resetBootForTest();

    const broken = await boot();
    const c = broken.cache;
    if (!c) throw new Error('boot');
    vi.spyOn(c, 'tx').mockRejectedValue(new Error('disk'));
    expect(await localUnsentCount()).toBeNull();
    vi.restoreAllMocks();

    expect(await localUnsentCount({ ...broken, outbox: null })).toBeNull();
    expect(await localUnsentCount({ ...broken, cache: null })).toBeNull();
  });
});
