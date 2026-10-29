// 换账号和正在进行的队列操作交错（K6 复审 N1、N2、N5、N6）：
// 上一个账号的项不能写回新账号的库；封存以后除了清空一律不能写；清空按库里实际的仓名（含旧仓）；抵消依赖项时不动 inflight
import { beforeEach, describe, expect, it } from 'vitest';
import { cacheOwner, claimCache } from '../account.ts';
import { CacheClosedError, openCache, type Cache } from '../cache.ts';
import { cacheStores, type StoreDef } from '../cache-schema.ts';
import { createOutbox, type Outbox } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
});

async function ownedByA(factory: IDBFactory = fakeIndexedDB().factory): Promise<{ cache: Cache; outbox: Outbox }> {
  const r = await openCache({ factory });
  if (!r.ok) throw new Error('open');
  await claimCache(r.cache, 'A');
  const outbox = createOutbox(r.cache, { appVersion: '4.0.0' });
  await outbox.boot();
  return { cache: r.cache, outbox };
}

const outboxRows = (cache: Cache): Promise<unknown[]> => cache.tx(['outbox'], 'readonly', (t) => t.getAll('outbox'));

describe('N1：失败处理、重试进行到一半时换了账号', () => {
  for (const kind of ['transient', 'permanent', 'retryFailed'] as const) {
    it(`${kind}：A 的项不会写回 B 的库`, async () => {
      const { cache, outbox } = await ownedByA();
      await outbox.enqueue({ table: 'categories', id: uid(1), op: 'insert', data: { id: uid(1), name: 'A的分类' } });
      const sent = await outbox.next();
      if (!sent) throw new Error('next');
      let p: Promise<unknown>;
      if (kind === 'retryFailed') {
        await outbox.fail(sent.op_id, { status: 400, sid: null });
        p = outbox.retryFailed();
      } else {
        p = outbox.fail(sent.op_id, kind === 'transient' ? { network: true, sid: null } : { status: 400, sid: null });
      }
      // watchAccount 的 closeGate：同步设闸、封存，随后清库记成 B
      outbox.suspend();
      cache.seal();
      const c = claimCache(cache, 'B');
      await Promise.allSettled([p, c]);
      expect(await cacheOwner(cache)).toBe('B');
      expect(await outboxRows(cache)).toEqual([]);
      expect(await cache.getRow('categories', uid(1))).toBeUndefined();
    });

    it(`${kind}：没设闸（只有别的标签页清了库）时，写事务里重新读，项没了就不写`, async () => {
      const { cache, outbox } = await ownedByA();
      await outbox.enqueue({ table: 'categories', id: uid(1), op: 'insert', data: { id: uid(1), name: 'A的分类' } });
      const sent = await outbox.next();
      if (!sent) throw new Error('next');
      let p: Promise<unknown>;
      if (kind === 'retryFailed') {
        await outbox.fail(sent.op_id, { status: 400, sid: null });
        p = outbox.retryFailed();
      } else {
        p = outbox.fail(sent.op_id, kind === 'transient' ? { network: true, sid: null } : { status: 400, sid: null });
      }
      const c = claimCache(cache, 'B');
      await Promise.allSettled([p, c]);
      expect(await cacheOwner(cache)).toBe('B');
      expect(await outboxRows(cache)).toEqual([]);
    });
  }
});

describe('N2：封存', () => {
  it('封存以后 setMeta、putDraft、enqueue 的写事务都被拒（CacheClosedError）；读照常；claimCache、clearAll 照样能清', async () => {
    const { cache } = await ownedByA();
    await cache.setMeta('schema_v', 1);
    cache.seal();
    expect(cache.isSealed()).toBe(true);
    await expect(cache.setMeta('schema_v', 2)).rejects.toBeInstanceOf(CacheClosedError);
    await expect(cache.putDraft({ id: 'd', kind: 'capture', data: 1, updated_at: 1 })).rejects.toBeInstanceOf(CacheClosedError);
    const ob = createOutbox(cache, { appVersion: '4.0.0' });
    await expect(ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) })).rejects.toBeInstanceOf(CacheClosedError);
    expect(await cache.getMeta('schema_v')).toBe(1);
    expect(await claimCache(cache, 'B')).toBe('switched');
    expect(await cache.getMeta('schema_v')).toBeUndefined();
    await cache.clearAll();
    expect(await cacheOwner(cache)).toBeUndefined();
  });
});

describe('N5：清空按库里实际的仓名', () => {
  it('stores 以外的旧仓（迁移漏删的）也一起清掉', async () => {
    const { factory } = fakeIndexedDB();
    const legacy: StoreDef = { name: 'legacy_cache', keyPath: 'id', indexes: [], rebuildable: true, kind: 'local' };
    const withLegacy = [...cacheStores(), legacy];
    const first = await openCache({ factory, stores: withLegacy });
    if (!first.ok) throw new Error('open');
    await claimCache(first.cache, 'A');
    await first.cache.tx(['legacy_cache'], 'readwrite', (t) => t.put('legacy_cache', { id: 'x', from: 'A' }));
    first.cache.close();

    const r = await openCache({ factory });   // 当前版本的 stores 里没有 legacy_cache
    if (!r.ok) throw new Error('open');
    expect(r.cache.storeNames()).toContain('legacy_cache');
    expect(await claimCache(r.cache, 'B')).toBe('switched');
    expect(await r.cache.tx(['legacy_cache'], 'readonly', (t) => t.getAll('legacy_cache'))).toEqual([]);
    r.cache.close();
  });
});

describe('N6：抵消依赖项时不动 inflight 的项', () => {
  it('依赖被抵消记录、但已经在发送中的项留着，由 ack / fail 处理', async () => {
    const { cache, outbox } = await ownedByA();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2), deps: [{ table: 'todos', id: uid(1) }] });
    // 手工把 uid(2) 的项标成 inflight（正常顺序下它不会先发，这里只验证 cancelDependents 不碰 inflight）
    await cache.tx(['outbox'], 'readwrite', async (t) => {
      const all = await t.getAll<{ op_id: string; rec: string; state: string }>('outbox');
      for (const i of all) if (i.rec === `todos:${uid(2)}`) await t.put('outbox', { ...i, state: 'inflight' });
    });
    expect(await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { undone: true } })).toBeNull();
    const left = (await outbox.list()).map((i) => [i.rec, i.state]);
    expect(left).toEqual([[`todos:${uid(2)}`, 'inflight']]);
  });
});
