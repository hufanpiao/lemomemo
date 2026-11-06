// “未同步”的重试（UNSYNCED-retry-ui）：真 outbox 上只重发给定记录里发送失败、不是 gone 的项；没有可重试的不调 retryFailed；库已关当作停下
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheClosedError } from '../../../core/cache.ts';
import { OUTBOX } from '../../../core/cache-schema.ts';
import type { OutboxItem } from '../../../core/outbox-types.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { clock, mk, seed, setup, todo, uid } from '../../../core/__tests__/outbox-fixtures.ts';
import { retryUnsynced } from '../data/retry-unsynced.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

const rec = (n: number): string => `todos:${uid(n)}`;

describe('retryUnsynced（真 outbox）', () => {
  it('只把给定记录里 failed、非 gone 的项改回 pending；别的记录、gone 不动；改完 remindRecs 里还在（等回执才移出）', async () => {
    const { cache, outbox } = await setup();
    for (const n of [1, 2, 3]) await seed(cache, 'todos', uid(n), todo(n), 5);
    // 1：带提醒、永久失败；2：不带提醒、永久失败（不在给定记录里）；3：带提醒、gone
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '坏的' }, remind: true });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '也坏' } });
    await outbox.enqueue({ table: 'todos', id: uid(3), op: 'patch', data: { title: '删了' }, remind: true });
    // 发送顺序不一定按入队顺序：按发出来的是哪一条决定怎么失败
    for (let n = 0; n < 3; n++) {
      const it = await outbox.next();
      const gone = it?.id === uid(3);
      await outbox.fail(it?.op_id ?? '', gone ? { status: 409, code: 'gone', sid: null } : { status: 409, code: '23503', sid: null });
    }
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 3 });
    // retryRecs：带提醒、有失败非 gone 项的记录（2 不带提醒，3 是 gone）
    expect(outbox.getStatus().retryRecs).toEqual(new Set([rec(1)]));
    const notify = vi.fn();
    outbox.subscribe(notify);

    expect(await retryUnsynced(outbox, outbox.getStatus().remindRecs)).toBe(1);
    const byId = new Map((await outbox.list()).map((i) => [i.id, i]));
    expect(byId.get(uid(1))).toMatchObject({ state: 'pending', tries: 0, error: null });
    expect(byId.get(uid(2))).toMatchObject({ state: 'failed' });
    expect(byId.get(uid(3))).toMatchObject({ state: 'failed', error: 'gone' });
    expect(outbox.getStatus()).toMatchObject({ pending: 1, failed: 2 });
    expect(notify).toHaveBeenCalled(); // 引擎靠这个通知去发
    expect(outbox.getStatus().remindRecs).toEqual(new Set([rec(1), rec(3)]));
    expect(outbox.getStatus().retryRecs.size).toBe(0);

    // 发出去成功以后移出“未同步”
    const it = await outbox.next();
    expect(it?.id).toBe(uid(1));
    await outbox.ack(it?.op_id ?? '', { status: 'ok', rev: 6, prev_rev: 5 });
    expect(outbox.getStatus().remindRecs).toEqual(new Set([rec(3)]));
  });

  it('只有“哪条能重试”变了（计数、remindRecs 都没变）：状态照样换新、通知订阅者', async () => {
    const { cache, outbox } = await setup();
    const put = (items: OutboxItem[]) => cache.tx([OUTBOX], 'readwrite', async (t) => {
      for (const i of items) await t.put(OUTBOX, i);
    });
    const f = (seq: number, n: number, error: string): OutboxItem => ({ ...mk({ seq, id: uid(n) }), state: 'failed', error, remind: true });
    await put([f(1, 1, '23503'), f(2, 2, 'gone')]);
    await outbox.retryFailed(['没有这一项']); // 只为触发一次 refresh
    expect(outbox.getStatus().retryRecs).toEqual(new Set([rec(1)]));
    const notify = vi.fn();
    outbox.subscribe(notify);
    await put([f(1, 1, 'gone'), f(2, 2, '23503')]);
    await outbox.retryFailed(['没有这一项']);
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 2 });
    expect(outbox.getStatus().retryRecs).toEqual(new Set([rec(2)]));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('同一条记录前后两次修改都失败：两项一起重发（不只带提醒的那项）', async () => {
    const failed = (seq: number, remind: boolean): OutboxItem => ({ ...mk({ seq, id: uid(1) }), state: 'failed', error: 'permanent', remind });
    const items = [failed(1, false), failed(2, true)];
    const retryFailed = vi.fn(async () => undefined);
    expect(await retryUnsynced({ list: async () => items, retryFailed }, new Set([rec(1)]))).toBe(2);
    expect(retryFailed).toHaveBeenCalledWith(items.map((i) => i.op_id));
  });
});

describe('retryUnsynced（替身）', () => {
  it('没有可重试的（只有待发、在途、gone，或不在给定记录里）：返回 0，不调 retryFailed', async () => {
    const items: OutboxItem[] = [
      { ...mk({ seq: 1, id: uid(1) }), state: 'pending', remind: true },
      { ...mk({ seq: 2, id: uid(2) }), state: 'inflight', remind: true },
      { ...mk({ seq: 3, id: uid(3) }), state: 'failed', error: 'gone', remind: true },
      { ...mk({ seq: 4, id: uid(4) }), state: 'failed', error: 'permanent', remind: true },
    ];
    const retryFailed = vi.fn(async () => undefined);
    expect(await retryUnsynced({ list: async () => items, retryFailed }, new Set([1, 2, 3].map(rec)))).toBe(0);
    expect(retryFailed).not.toHaveBeenCalled();
  });

  it('库已关（CacheClosedError）当作停下返回 0；别的错照常抛出', async () => {
    const retryFailed = vi.fn(async () => undefined);
    const closed = { list: async (): Promise<OutboxItem[]> => Promise.reject(new CacheClosedError()), retryFailed };
    expect(await retryUnsynced(closed, new Set([rec(1)]))).toBe(0);
    const items = [{ ...mk({ seq: 1, id: uid(1) }), state: 'failed', error: 'permanent' } as OutboxItem];
    const boom = { list: async () => items, retryFailed: vi.fn(async () => Promise.reject(new Error('坏了'))) };
    await expect(retryUnsynced(boom, new Set([rec(1)]))).rejects.toThrow('坏了');
  });
});
