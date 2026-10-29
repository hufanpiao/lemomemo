// K8 发送循环 × apply_patch 4.4.1（0.38 第 57 条）：patch_table_not_allowed、patch_bad_args 丢掉；55P03 锁超时临时失败重试；
// account_disabled 的现行处理；notes 冲突 forked 带 fork_id
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllCollections } from '../../store.ts';
import { clock, seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import type { Outbox } from '../../outbox-types.ts';
import { sendAll, type SendDeps } from '../send.ts';
import type { SyncEvent } from '../types.ts';
import { fakeTransport, type FakeTransport } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

function deps(outbox: Outbox, t: FakeTransport): SendDeps & { events: SyncEvent[]; removedCodes: string[] } {
  const events: SyncEvent[] = [];
  const removedCodes: string[] = [];
  return {
    outbox,
    transport: t,
    gated: () => outbox.isSuspended(),
    blocked: () => false,
    emit: (e) => events.push(e),
    removed: (c) => removedCodes.push(c),
    touched: () => undefined,
    events,
    removedCodes,
  };
}

async function seedBoth(t: FakeTransport, cache: Parameters<typeof seed>[0], n: number): Promise<string> {
  const id = uid(n);
  const row = t.server.insert('todos', todo(n));
  await seed(cache, 'todos', id, todo(n), row.rev);
  return id;
}

describe('apply_patch 4.4.1 的错误码与 forked（0.38 第 57 条）', () => {
  it('patch_table_not_allowed、patch_bad_args：永久错误，丢掉这一项、不进“发送失败”区，不挡后面的项', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id1 = await seedBoth(t, cache, 1);
    const id2 = await seedBoth(t, cache, 2);
    const id3 = await seedBoth(t, cache, 3);
    t.server.allowedTables.delete('todos');
    await outbox.enqueue({ table: 'todos', id: id1, op: 'patch', data: { title: 'a' } });
    expect(await sendAll(deps(outbox, t))).toBe('done');
    expect(await outbox.list()).toEqual([]);

    t.server.allowedTables.add('todos');
    t.failNext.push({ status: 400, code: 'patch_bad_args' });
    await outbox.enqueue({ table: 'todos', id: id2, op: 'patch', data: { title: 'b' } });
    await outbox.enqueue({ table: 'todos', id: id3, op: 'patch', data: { title: 'c' } });
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 0 });
    expect(t.server.table('todos').get(id2)?.['title']).not.toBe('b');
    expect(t.server.table('todos').get(id3)?.['title']).toBe('c');
    expect(d.events).toEqual([]);
  });

  it('假服务器：base_rev < 1 回 patch_bad_args', () => {
    const t = fakeTransport();
    t.server.insert('todos', todo(1));
    expect(t.server.patchError({ p_table: 'todos', p_id: uid(1), p_patch: { title: 'x' }, p_base_rev: 0, p_op_id: 'o', p_own_revs: [] }))
      .toEqual({ status: 400, code: 'patch_bad_args' });
  });

  it('55P03（锁超时 3 秒）：当临时失败，退避、tries 加 1、不进“发送失败”区；锁放开后发出', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = await seedBoth(t, cache, 1);
    t.server.locked.add(id);
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: '锁住时改' } });
    expect(await sendAll(deps(outbox, t))).toBe('retry');
    const [item] = await outbox.list();
    expect(item).toMatchObject({ state: 'pending', tries: 1 });
    expect(item?.next_at).toBeGreaterThan(clock.t);
    expect(outbox.getStatus().failed).toBe(0);

    t.server.locked.clear();
    await outbox.clearBackoff();
    expect(await sendAll(deps(outbox, t))).toBe('done');
    expect(t.server.table('todos').get(id)?.['title']).toBe('锁住时改');
  });

  it('account_disabled（照架构 4.3，K6 的 disabled 类）：outbox 设闸、发 disabled 事件，sendAll 停发（清库、回登录页由 sync-wiring 接 disabled 事件做）', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = await seedBoth(t, cache, 1);
    t.server.disabled = true;
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: 'x' } });
    const d = deps(outbox, t);
    const outboxEvents: string[] = [];
    outbox.onEvent((e) => outboxEvents.push(e.type));
    expect(await sendAll(d)).toBe('stopped');
    expect(d.removedCodes).toEqual([]);
    expect(outboxEvents).toEqual(['disabled']);
    expect(outbox.isSuspended()).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(1);   // 不按 not_found 丢项（4.4.1 的“不丢队列”）
  });

  it('notes 的 title 冲突 → forked：事件带 forkId，服务器多一条冲突副本，原行不改 title、照改别的键', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = uid(1);
    const row = t.server.insert('notes', { id, title: '原标题', body: '正文', tags: [] });
    await seed(cache, 'notes', id, { id, title: '原标题', body: '正文', tags: [] }, row.rev);
    t.server.edit('notes', id, { title: '另一台改的' });
    await outbox.enqueue({ table: 'notes', id, op: 'patch', data: { title: '本机改的', tags: ['本机'] } });
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ type: 'conflict', status: 'forked', table: 'notes', id, conflicts: ['title'], forkId: 'fork-1' });
    expect(t.server.table('notes').get(id)).toMatchObject({ title: '另一台改的', tags: ['本机'] });
    expect(t.server.table('notes').get('fork-1')?.['title']).toBe('本机改的（冲突副本）');
    expect(outbox.getStatus().pending).toBe(0);
  });

  it('普通冲突的事件 forkId 为 null', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = await seedBoth(t, cache, 1);
    t.server.edit('todos', id, { title: '另一台' });
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: '本机' } });
    const d = deps(outbox, t);
    await sendAll(d);
    expect(d.events[0]).toMatchObject({ status: 'conflict', forkId: null });
  });
});
