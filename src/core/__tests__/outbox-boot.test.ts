// 离线队列带版本（TC-B1-41）和 pending_actions（0.29 续第 107 条）
import { beforeEach, describe, expect, it } from 'vitest';
import { createOutbox, drainPendingActions } from '../outbox.ts';
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
  it('别的账号的、超过 24 小时的丢掉，其余转进 outbox', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1));
    const H = 3600_000;
    await cache.tx(['pending_actions'], 'readwrite', async (t) => {
      await t.put('pending_actions', { id: 'p1', user_id: 'me', created_at: clock.t - H, action: { done: uid(1) } });
      await t.put('pending_actions', { id: 'p2', user_id: 'other', created_at: clock.t, action: { done: uid(1) } });
      await t.put('pending_actions', { id: 'p3', user_id: 'me', created_at: clock.t - 25 * H, action: { done: uid(1) } });
    });
    const n = await drainPendingActions(cache, outbox, {
      userId: 'me',
      now: clock.t,
      toEnqueue: (a) => ({ table: 'todos', id: (a.action as { done: string }).done, op: 'patch', data: { done: true } }),
    });
    expect(n).toBe(1);
    expect(await cache.tx(['pending_actions'], 'readonly', (t) => t.getAll('pending_actions'))).toEqual([]);
    expect((await outbox.list())[0]).toMatchObject({ data: { done: true } });
  });
});
