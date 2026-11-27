// 换账号测试共用的建库和样例数据（不是测试文件本身）
import { claimCache } from '../account.ts';
import { openCache, type Cache } from '../cache.ts';
import { collection } from '../store.ts';
import { fakeIndexedDB } from './idb-fake.ts';

export async function freshCache(factory: IDBFactory = fakeIndexedDB().factory): Promise<Cache> {
  const r = await openCache({ factory });
  if (!r.ok) throw new Error('open');
  return r.cache;
}

/** A 账号的本机数据：同步行、没发的 outbox、通知按键、草稿 */
export async function seedA(cache: Cache): Promise<void> {
  await claimCache(cache, 'A');
  await cache.putRows('todos', [{ id: 't', server: { id: 't', rev: 1 }, view: { id: 't', rev: 1 } }]);
  await cache.tx(['outbox', 'pending_actions'], 'readwrite', async (t) => {
    await t.put('outbox', { op_id: 'o', rec: 'todos:t', seq: 1, state: 'pending', v: 1, next_at: 0, deps: [] });
    await t.put('pending_actions', { id: 'p', user_id: 'A', created_at: 1 });
  });
  await cache.putDraft({ id: 'd', kind: 'capture', data: 'A 的草稿', updated_at: 1 });
  collection('todos').upsert([{ id: 't' }]);
}

/** 同步行 + outbox + pending_actions + drafts 一共几条 */
export async function count(cache: Cache): Promise<number> {
  return cache.tx(['todos', 'outbox', 'pending_actions', 'drafts'], 'readonly', async (t) => {
    let n = 0;
    for (const s of ['todos', 'outbox', 'pending_actions', 'drafts']) n += (await t.getAll(s)).length;
    return n;
  });
}
