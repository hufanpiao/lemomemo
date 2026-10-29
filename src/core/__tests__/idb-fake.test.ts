// IndexedDB 替身的保真度（K6 审查 L1）：替身不像真浏览器，上面的测试就会放过真问题
// 范围重叠的 readwrite 串行、没有脏读、并发 enqueue 的 seq 不重复、活动期检查、成功回调抛错就中止
// 真浏览器上的行为仍要 E2E 或真机补测（接手清单 P-idb-tx）
import { describe, expect, it } from 'vitest';
import { openCache, type Cache } from '../cache.ts';
import { META } from '../cache-schema.ts';
import { createOutbox } from '../outbox.ts';
import { fakeIndexedDB, type FakeDB } from './idb-fake.ts';

async function open(): Promise<{ cache: Cache; factory: IDBFactory }> {
  const { factory } = fakeIndexedDB();
  const r = await openCache({ factory, name: 'fidelity' });
  if (!r.ok) throw new Error(r.error);
  return { cache: r.cache, factory };
}

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('IndexedDB 替身的保真度', () => {
  it('两个范围重叠的 readwrite：后一个等前一个结束；前一个中止不会盖掉后一个的写入', async () => {
    const { cache } = await open();
    const a = cache
      .tx([META], 'readwrite', async (t) => {
        await t.put(META, { key: 'schema_v', value: 1 });
        await t.get(META, 'schema_v');
        throw new Error('boom');
      })
      .catch((e: unknown) => (e as Error).message);
    let bSaw: unknown = 'not-run';
    const b = cache.tx([META], 'readwrite', async (t) => {
      bSaw = await t.get(META, 'schema_v');
      await t.put(META, { key: 'schema_v', value: 2 });
    });
    expect(await a).toBe('boom');
    await b;
    // B 的请求在 A 中止（回滚）之后才执行：看不到 A 的写入
    expect(bSaw).toBeUndefined();
    expect(await cache.getMeta('schema_v')).toBe(2);
  });

  it('只读事务读不到别的事务还没提交、随后中止的写入（没有脏读）', async () => {
    const { cache } = await open();
    await cache.setMeta('schema_v', 3);
    const w = cache
      .tx([META], 'readwrite', async (t) => {
        await t.put(META, { key: 'schema_v', value: 4 });
        await t.get(META, 'schema_v');
        throw new Error('rollback');
      })
      .catch(() => 'aborted');
    expect(await cache.getMeta('schema_v')).toBe(3);
    expect(await w).toBe('aborted');
    expect(await cache.getMeta('schema_v')).toBe(3);
  });

  it('两个并发 enqueue（不同记录）：seq 不重复', async () => {
    const { cache } = await open();
    const ob = createOutbox(cache, { appVersion: '4.0.0' });
    await ob.boot();
    const mk = (n: number) => ({ table: 'categories', id: uid(n), op: 'insert' as const, data: { id: uid(n), name: `c${n}` } });
    const res = await Promise.allSettled([ob.enqueue(mk(1)), ob.enqueue(mk(2))]);
    const seqs = (await ob.list()).map((i) => i.seq);
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('活动期：await 了定时器之后再发请求，抛 TransactionInactiveError', async () => {
    const { cache } = await open();
    const err = await cache
      .tx([META], 'readwrite', async (t) => {
        await t.get(META, 'x');
        await new Promise((r) => setTimeout(r, 5));
        await t.put(META, { key: 'schema_v', value: 5 });
      })
      .catch((e: unknown) => (e as DOMException).name);
    expect(err).toBe('TransactionInactiveError');
    expect(await cache.getMeta('schema_v')).toBeUndefined();
  });

  it('成功回调里抛错：事务中止，之前的写入回滚', async () => {
    const { factory } = fakeIndexedDB();
    const req = factory.open('raw', 1);
    const db = await new Promise<FakeDB>((resolve) => {
      req.onupgradeneeded = () => (req.result as unknown as FakeDB).createObjectStore('s', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result as unknown as FakeDB);
    });
    const tx = db.transaction(['s'], 'readwrite');
    const aborted = new Promise<string>((resolve) => {
      tx.onabort = () => resolve('aborted');
      tx.oncomplete = () => resolve('complete');
    });
    tx.objectStore('s').put({ id: 1 });
    const g = tx.objectStore('s').get(1);
    g.onsuccess = () => {
      throw new Error('handler');
    };
    expect(await aborted).toBe('aborted');
    const rt = db.transaction(['s'], 'readonly');
    const all = rt.objectStore('s').getAll();
    const rows = await new Promise<unknown[]>((resolve) => {
      all.onsuccess = () => resolve(all.result as unknown[]);
    });
    expect(rows).toEqual([]);
  });
});
