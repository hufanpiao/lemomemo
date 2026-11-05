// core/write-gone.ts（K8 冲突提示，方案 4.2、4.3 的 M7 和返回值映射）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GoneModule from '../outbox-gone.ts';

// 两条映射用例要让 resolveGoneImpl 抛指定的错：hit.err 有值时下一次调用直接抛它
const hit = vi.hoisted(() => ({ err: null as unknown }));
vi.mock('../outbox-gone.ts', async (orig) => {
  const m = await orig<typeof GoneModule>();
  return {
    ...m,
    resolveGoneImpl: (...a: Parameters<typeof m.resolveGoneImpl>) => {
      const e = hit.err;
      hit.err = null;
      return e ? Promise.reject(e) : m.resolveGoneImpl(...a);
    },
  };
});
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../boot.ts';
import { clearAllCollections } from '../store.ts';
import { resolveGone, restoredRemind } from '../write-gone.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { todo, uid } from './outbox-fixtures.ts';

const NOW = Date.UTC(2026, 10, 5, 0, 0);   // 首尔 11 月 5 日 09:00
const TZ = 'Asia/Seoul';

describe('restoredRemind：恢复以后带不带提醒（M7，规则同各编辑页）', () => {
  it('待办：截止日在以后、当天 09:00 提醒 → true；截止日早就过了 → false；已完成 → false', () => {
    const t = { ...todo(1), due: '2026-11-06', remind_days: 0, remind_time: '09:00', deleted_at: null };
    expect(restoredRemind('todos', t, { deleted_at: null }, TZ, NOW)).toBe(true);
    expect(restoredRemind('todos', { ...t, due: '2026-10-01' }, { deleted_at: null }, TZ, NOW)).toBe(false);
    expect(restoredRemind('todos', { ...t, done: true }, { deleted_at: null }, TZ, NOW)).toBe(false);
  });

  it('待办：按过“稍后”（snooze_at 还没到）→ true，按字段算不出来也算', () => {
    const t = { ...todo(1), due: null, deleted_at: null, snooze_at: NOW + 60_000 };
    expect(restoredRemind('todos', t, { deleted_at: null }, TZ, NOW)).toBe(true);
  });

  it('日程：有时刻、提前 10 分钟，在以后 → true；在以前 → false；没开提醒 → false', () => {
    const e = { id: uid(2), date: '2026-11-06', time: '10:00', tz: TZ, remind_min: 10, remind_days: null, deleted_at: null };
    expect(restoredRemind('events', e, { deleted_at: null }, TZ, NOW)).toBe(true);
    expect(restoredRemind('events', { ...e, date: '2026-11-01' }, { deleted_at: null }, TZ, NOW)).toBe(false);
    expect(restoredRemind('events', { ...e, remind_min: null }, { deleted_at: null }, TZ, NOW)).toBe(false);
  });

  it('别的表（随手记、纪念日、分类）不带', () => {
    expect(restoredRemind('notes', { id: uid(3), title: 'x' }, { deleted_at: null }, TZ, NOW)).toBe(false);
    expect(restoredRemind('categories', { id: uid(3), name: 'x' }, { deleted_at: null }, TZ, NOW)).toBe(false);
  });
});

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

/** 启动，造一条服务器上已软删、本机有一项 gone 的待办 */
async function bootWithGone(data: Record<string, unknown>): Promise<void> {
  const { factory } = fakeIndexedDB();
  await coldStart(opts(factory));
  const b = getBoot();
  const cache = b?.cache;
  const outbox = b?.outbox;
  if (!cache || !outbox) throw new Error('boot');
  const row = { ...todo(1), id: uid(1), rev: 7, deleted_at: null };
  await cache.putRows('todos', [{ id: uid(1), server: row, view: row }]);
  await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data });
  const sent = await outbox.next();
  if (!sent) throw new Error('next');
  await outbox.fail(sent.op_id, { status: 409, code: 'gone', sid: null });
  const del = { ...row, deleted_at: 900_000 };
  await cache.putRows('todos', [{ id: uid(1), server: del, view: del }]);
}

describe('resolveGone：返回值映射（方案 4.2）', () => {
  it('还没启动：local_unavailable，不抛错', async () => {
    expect(await resolveGone('todos', uid(1), 'restore')).toEqual({ ok: false, reason: 'local_unavailable' });
  });

  it('恢复：restored，队列里是一项 pending patch；再点一次：nothing', async () => {
    await bootWithGone({ title: '我的修改' });
    const r = await resolveGone('todos', uid(1), 'restore');
    expect(r).toMatchObject({ ok: true, done: 'restored', opId: expect.any(String) });
    const list = (await getBoot()?.outbox?.list()) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: 'pending', data: { title: '我的修改', deleted_at: null } });
    expect(r.ok && r.opId).toBe(list[0]?.op_id);
    expect(await resolveGone('todos', uid(1), 'restore')).toEqual({ ok: true, done: 'nothing', opId: null });
  });

  it('不用了：dropped，队列空了', async () => {
    await bootWithGone({ title: '我的修改' });
    expect(await resolveGone('todos', uid(1), 'drop')).toEqual({ ok: true, done: 'dropped', opId: null });
    expect(await getBoot()?.outbox?.list()).toEqual([]);
  });

  it('合并后是撤销：rejected / undone（M8、R2 ④）', async () => {
    await bootWithGone({ undone: true });
    expect(await resolveGone('todos', uid(1), 'restore')).toEqual({ ok: false, reason: 'rejected', code: 'undone' });
  });

  it('只读行（真走一遍 resolveGoneImpl）：rejected / readonly_row（代码审查 S4）', async () => {
    await bootWithGone({ title: '我的修改' });
    const cache = getBoot()?.cache;
    if (!cache) throw new Error('cache');
    const row = await cache.getRow('todos', uid(1));
    if (!row) throw new Error('row');
    await cache.putRows('todos', [{ ...row, ro: true }]);
    expect(await resolveGone('todos', uid(1), 'restore')).toEqual({ ok: false, reason: 'rejected', code: 'readonly_row' });
  });

  it('设了闸：switching', async () => {
    await bootWithGone({ title: '我的修改' });
    getBoot()?.outbox?.suspend();
    expect(await resolveGone('todos', uid(1), 'restore')).toEqual({ ok: false, reason: 'switching' });
  });

  it('库正在关（途中抛 CacheClosedError）：closing', async () => {
    await bootWithGone({ title: '我的修改' });
    const { CacheClosedError } = await import('../cache.ts');
    hit.err = new CacheClosedError();
    expect(await resolveGone('todos', uid(1), 'drop')).toEqual({ ok: false, reason: 'closing' });
  });

  it('outbox-gone.ts 那一批下载不下来（OutboxCodeUnavailableError）：local_unavailable（稍后再试）', async () => {
    await bootWithGone({ title: '我的修改' });
    const { OutboxCodeUnavailableError } = await import('../outbox-logic.ts');
    hit.err = new OutboxCodeUnavailableError(new TypeError('Failed to fetch dynamically imported module'));
    expect(await resolveGone('todos', uid(1), 'restore')).toEqual({ ok: false, reason: 'local_unavailable' });
  });

  it('remindOf 按恢复后的整行现算：截止日在以后的待办带 remind', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      await bootWithGone({ due: '2026-11-06', remind_days: 0, remind_time: '09:00' });
      expect(await resolveGone('todos', uid(1), 'restore')).toMatchObject({ ok: true, done: 'restored', opId: expect.any(String) });
      expect((await getBoot()?.outbox?.list())?.[0]?.remind).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
