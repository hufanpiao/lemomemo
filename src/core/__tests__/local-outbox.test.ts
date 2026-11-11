// R-382（架构 4.1a 第 2 点）：登录页只数 outbox 的条数；库不存在不建库
import { describe, expect, it } from 'vitest';
import { openCache } from '../cache.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { createLocalOutbox } from '../../platform/local-outbox.ts';

/** 直接往 outbox 仓塞 n 条（只为测条数，不经 core/outbox.ts） */
function seed(factory: IDBFactory, n: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open('planner-v4');
    req.onerror = () => reject(new Error('open'));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('outbox', 'readwrite');
      for (let i = 0; i < n; i++) tx.objectStore('outbox').put({ op_id: `op${i}`, rec: `notes:${i}` });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    };
  });
}

describe('localOutbox.count', () => {
  it('库不存在：回 0，也不建库（升级中止，版本仍是 0、没有仓）', async () => {
    const { factory, fake } = fakeIndexedDB();
    expect(await createLocalOutbox({ factory }).count()).toBe(0);
    const d = fake.dbs.get('planner-v4');
    expect(d?.version ?? 0).toBe(0);
    expect(d?.stores.size ?? 0).toBe(0);
  });

  it('库在：回 outbox 仓的条数；读完把连接关掉（之后删库不被挡）', async () => {
    const { factory, fake } = fakeIndexedDB();
    const r = await openCache({ factory });
    if (!r.ok) throw new Error('open');
    r.cache.close();
    expect(await createLocalOutbox({ factory }).count()).toBe(0);
    await seed(factory, 3);
    expect(await createLocalOutbox({ factory }).count()).toBe(3);
    expect(fake.dbs.get('planner-v4')?.connections.size).toBe(0);
  });

  it('打开被挡住或超时：回 null（界面不提示条数）', async () => {
    const never = { open: () => ({}) } as unknown as IDBFactory;
    expect(await createLocalOutbox({ factory: never, timeoutMs: 10 }).count()).toBeNull();
  });
});
