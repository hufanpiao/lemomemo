// 离线队列带版本（TC-B1-41）和 pending_actions（0.29 续第 107 条）
import { beforeEach, describe, expect, it } from 'vitest';
import { createOutbox, drainPendingActions, isValidPendingAction, keepPendingAction, prunePendingActions } from '../outbox.ts';
import { migrateOutboxItem } from '../outbox-migrations.ts';
import { clearAllCollections } from '../store.ts';
import { clock, mk, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('队列带版本（TC-B1-41）', () => {
  it('migrateOutboxItem：低版本逐级改；高版本留着；缺迁移、迁移抛错都留着不删', () => {
    const m = [{ to: 2, up: (o: Readonly<Record<string, unknown>>) => ({ ...o, deps: [] }) }];
    expect(migrateOutboxItem({ v: 1, op_id: 'a' }, m, 2)).toEqual({ kind: 'ok', item: { v: 2, op_id: 'a', deps: [] }, changed: true });
    expect(migrateOutboxItem({ v: 3 }, m, 2)).toEqual({ kind: 'future' });
    expect(migrateOutboxItem({ v: 1 }, [], 2)).toEqual({ kind: 'stuck', error: 'outbox_migration_missing:2' });
    expect(migrateOutboxItem({ v: 1 }, [{ to: 2, up: () => { throw new TypeError('x'); } }], 2)).toEqual({ kind: 'stuck', error: 'TypeError' });
    expect(migrateOutboxItem({ v: 'x' }, m, 2).kind).toBe('stuck');
  });

  it('新版启动：v = 1 的旧项先改成当前格式再发；每项带 v、app；比自己高的 v 留着不发；inflight 复位', async () => {
    const { cache } = await setup();
    const old = mk({ seq: 1, id: uid(1), op: 'insert', data: todo(1), v: 1, state: 'inflight' });
    const { deps: _drop, ...v1shape } = old;   // v1 的旧格式没有 deps
    const future = mk({ seq: 2, id: uid(2), op: 'insert', data: todo(2), v: 3, op_id: 'future' });
    await cache.tx(['outbox'], 'readwrite', async (t) => {
      await t.put('outbox', v1shape);
      await t.put('outbox', future);
    });
    const ob = createOutbox(cache, {
      appVersion: '4.1.0',
      currentV: 2,
      migrations: [{ to: 2, up: (o) => ({ ...o, deps: [] }) }],
      now: () => clock.t,
    });
    const rep = await ob.boot();
    expect(rep).toMatchObject({ migrated: 1, future: 1, stuck: 0, reset: 1 });
    const list = await ob.list();
    expect(list[0]).toMatchObject({ v: 2, app: '4.0.0', deps: [], state: 'pending' });
    expect(list[1]).toMatchObject({ v: 3, op_id: 'future' });
    const n = await ob.next();
    expect(n?.op_id).toBe(old.op_id);
    await ob.ack(n?.op_id ?? '', { status: 'ok', rev: 1, prev_rev: null });
    expect(await ob.next()).toBeNull();   // v = 3 的不发
  });

  it('新入队的项带当前格式版本和 App 版本', async () => {
    const { outbox } = await setup('4.0.3');
    const it1 = await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    expect(it1).toMatchObject({ v: 1, app: '4.0.3' });
  });
});

describe('pending_actions（0.29 续第 107 条）', () => {
  const H = 3600_000;
  /** SW 写的那种项（src/sw/pending.ts 的 SwPendingAction） */
  const pa = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    user_id: 'me',
    row_table: 'todos',
    row_id: uid(1),
    action: { type: 'snooze', minutes: 10, due_at: 1_000_000 },
    created_at: clock.t - H,
    ...over,
  });
  const put = async (cache: Awaited<ReturnType<typeof setup>>['cache'], rows: Record<string, unknown>[]) =>
    cache.tx(['pending_actions'], 'readwrite', async (t) => {
      for (const r of rows) await t.put('pending_actions', r);
    });
  const left = async (cache: Awaited<ReturnType<typeof setup>>['cache']) =>
    (await cache.tx(['pending_actions'], 'readonly', (t) => t.getAll<{ id: string }>('pending_actions'))).map((a) => a.id).sort();

  it('别的账号的、超过 24 小时的丢掉，其余（已校验过形状）转进 outbox', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1));
    await put(cache, [pa('p1'), pa('p2', { user_id: 'other', created_at: clock.t }), pa('p3', { created_at: clock.t - 25 * H })]);
    const seen: unknown[] = [];
    const n = await drainPendingActions(cache, outbox, {
      userId: 'me',
      now: clock.t,
      toEnqueue: (a) => {
        seen.push(a);
        return { table: 'todos', id: a.row_id, op: 'patch', data: { done: true } };
      },
    });
    expect(n).toBe(1);
    expect(seen).toEqual([pa('p1')]);
    expect(await left(cache)).toEqual([]);
    expect((await outbox.list())[0]).toMatchObject({ data: { done: true } });
  });

  it('形状不对的不交给 toEnqueue（安全审查 FE-S3），照样删掉', async () => {
    const { cache, outbox } = await setup();
    await put(cache, [pa('bad-table', { row_table: 'profiles' }), pa('bad-row', { row_id: '../x' }), pa('bad-min', { action: { type: 'snooze', minutes: 0, due_at: 1 } })]);
    let calls = 0;
    const n = await drainPendingActions(cache, outbox, {
      userId: 'me',
      now: clock.t,
      toEnqueue: () => {
        calls++;
        return null;
      },
    });
    expect([n, calls]).toEqual([0, 0]);
    expect(await left(cache)).toEqual([]);
  });

  it('prunePendingActions（启动时先清）：别的账号的、超过 24 小时的、时间在将来的、形状不对的删掉', async () => {
    const { cache } = await setup();
    await put(cache, [
      pa('keep', { created_at: clock.t - 23 * H }),
      pa('edge', { created_at: clock.t - 24 * H }),
      pa('soon', { created_at: clock.t + 5 * 60_000 }),
      pa('future', { created_at: clock.t + 5 * 60_000 + 1 }),
      pa('other', { user_id: 'other', created_at: clock.t }),
      pa('old', { created_at: clock.t - 24 * H - 1 }),
      pa('bad-time', { created_at: 'x' }),
      pa('bad-table', { row_table: 'events_v2' }),
      pa('bad-row', { row_id: 'not-a-uuid' }),
      pa('bad-type', { action: { type: 'ack', due_at: 1 } }),   // “知道了”不写库，不是合法的 pending
      pa('bad-due', { action: { type: 'snooze', minutes: 10, due_at: 1.5 } }),
      pa('no-action', { action: undefined }),
      { id: 'noowner', created_at: clock.t, action: {} },
    ]);
    expect(await prunePendingActions(cache, { userId: 'me', now: clock.t })).toBe(10);
    expect(await left(cache)).toEqual(['edge', 'keep', 'soon']);
    expect(await prunePendingActions(cache, { userId: 'me', now: clock.t })).toBe(0);
  });

  it('keepPendingAction / isValidPendingAction：不是对象、字段缺、时间不是有限数都不留', () => {
    expect(keepPendingAction(null, 'me', 0)).toBe(false);
    expect(keepPendingAction({ ...pa('x'), created_at: Number.NaN }, 'me', clock.t)).toBe(false);
    expect(keepPendingAction(pa('x'), 'me', clock.t)).toBe(true);
    expect(isValidPendingAction({ ...pa('x'), id: '' })).toBe(false);
    for (const t of ['events', 'todos', 'anniversaries']) expect(isValidPendingAction(pa('x', { row_table: t }))).toBe(true);
  });
});
