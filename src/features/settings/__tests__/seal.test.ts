// 设置页清空本机走真的 core（假 IndexedDB）：K9 第三轮 M1
// • 清理一开始先 sealForExit 同步设闸：之后离线队列的 ack、fail 不再写库（不会把清掉的行、队列项写回来）
// • 计数（localUnsentCount）要在封存之前调：封存以后数不出来（null）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootResult } from '../../../core/boot.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { seed, todo, uid } from '../../../core/__tests__/outbox-fixtures.ts';
import { defaultExitDeps } from '../data/local.ts';

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

describe('退出时清空本机（真 core）', () => {
  it('先数（封存前能数出来），清理开始就设闸：之后 ack、fail 不再写库，清完库里什么也不剩', async () => {
    const b = await boot();
    const { cache, outbox } = b;
    if (!cache || !outbox) throw new Error('boot');
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改' } });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    const sending = await outbox.next();
    if (!sending) throw new Error('next');

    // 计数在封存之前：数得出来
    expect(await defaultExitDeps.pendingCount()).toBe(2);

    // 清理开始：wipe 一调用就同步设闸（不用等它做完）
    const wiping = defaultExitDeps.wipe();
    expect(b.switching).toBe(true);
    expect(outbox.isSuspended()).toBe(true);
    expect(cache.isSealed()).toBe(true);
    // 清理进行中，正在发的那一项的响应回来了
    await outbox.ack(sending.op_id, { status: 'ok', rev: 6, prev_rev: 5 });
    await outbox.fail(sending.op_id, { status: 400 });
    await wiping;
    // 清完之后又晚到一次
    await outbox.ack(sending.op_id, { status: 'ok', rev: 7, prev_rev: 6 });
    await outbox.fail(sending.op_id, { network: true });

    expect(await outbox.list()).toEqual([]);
    expect(await cache.getRow('todos', uid(1))).toBeUndefined();
    expect(await cache.getRow('todos', uid(2))).toBeUndefined();
    // 封存以后数不出来：所以界面一定先数再退出
    expect(await defaultExitDeps.pendingCount()).toBeNull();
  });
});
