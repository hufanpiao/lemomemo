// gone → 恢复 → 再发出去，服务器的三种口径（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.4；代码审查 S1 把审查探针收进仓库）：
// ① 补拉前恢复：服务器回 conflict，conflicts 含 deleted_at，行已恢复；事件的 opId 等于恢复项的 op_id（gate 据此过滤 deleted_at、undone）
// ② 随手记恢复时 title 也冲突：服务器回 forked，原行恢复、另存冲突副本；事件的 opId 等于恢复项（gate 据此不出卡，P1）
// ③ 恢复前行已被彻底删除：服务器回 not_found，恢复项被丢掉；outbox 的 rejected 事件 code = not_found、item.op_id 是恢复项（P2）
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllCollections } from '../../store.ts';
import { clock, seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { resolveGoneImpl } from '../../outbox-gone.ts';
import { outboxCtx } from '../../outbox.ts';
import type { Outbox, OutboxEvent } from '../../outbox-types.ts';
import { sendAll, type SendDeps } from '../send.ts';
import type { SyncEvent } from '../types.ts';
import { fakeTransport, type FakeTransport } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

function deps(outbox: Outbox, t: FakeTransport): SendDeps & { events: SyncEvent[] } {
  const events: SyncEvent[] = [];
  return {
    outbox, transport: t, gated: () => outbox.isSuspended(), blocked: () => false,
    emit: (e) => events.push(e), removed: () => undefined, touched: () => undefined, events,
  };
}

async function restore(outbox: Outbox, table: string, id: string): Promise<string> {
  const ctx = outboxCtx.get(outbox);
  if (!ctx) throw new Error('outboxCtx');
  const r = await resolveGoneImpl(ctx, table, id, 'restore');
  expect(r.done).toBe('restored');
  if (!r.opId) throw new Error('opId');
  return r.opId;
}

/** 本机改一次、另一台设备同时删掉（over 是删之前另一台设备先改的），发出去回 gone */
async function goneTodo(): Promise<{ outbox: Outbox; t: FakeTransport; id: string }> {
  const { cache, outbox } = await setup();
  const t = fakeTransport();
  const id = uid(1);
  const row = t.server.insert('todos', todo(1));
  await seed(cache, 'todos', id, todo(1), row.rev);
  await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: '本机改的' } });
  t.server.edit('todos', id, { deleted_at: 900_000 });
  const d = deps(outbox, t);
  await sendAll(d);
  expect(d.events.map((e) => e.type)).toEqual(['gone']);
  return { outbox, t, id };
}

describe('gone → 恢复 → 再发（服务器口径，代码审查 S1）', () => {
  it('① 补拉前恢复：回 conflict、conflicts 含 deleted_at，opId 等于恢复项；服务器行已恢复、本机的修改在', async () => {
    const { outbox, t, id } = await goneTodo();
    const opId = await restore(outbox, 'todos', id);
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ type: 'conflict', status: 'conflict', table: 'todos', id, opId });
    const ev = d.events[0];
    expect(ev?.type === 'conflict' ? ev.conflicts : []).toContain('deleted_at');
    expect(t.server.table('todos').get(id)).toMatchObject({ deleted_at: null, title: '本机改的' });
    expect(await outbox.list()).toEqual([]);
  });

  it('② 随手记恢复时 title 也冲突：回 forked，opId 等于恢复项；原行恢复，冲突副本是本机的标题', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = uid(2);
    const note = { id, title: '原标题', body: '正文', tags: [] };
    const row = t.server.insert('notes', note);
    await seed(cache, 'notes', id, note, row.rev);
    await outbox.enqueue({ table: 'notes', id, op: 'patch', data: { title: '本机改的' } });
    t.server.edit('notes', id, { title: '另一台改的' });
    t.server.edit('notes', id, { deleted_at: 900_000 });
    await sendAll(deps(outbox, t));
    const opId = await restore(outbox, 'notes', id);
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ type: 'conflict', status: 'forked', table: 'notes', id, opId, forkId: 'fork-1' });
    expect(t.server.table('notes').get(id)).toMatchObject({ deleted_at: null, title: '另一台改的' });
    expect(t.server.table('notes').get('fork-1')?.['title']).toBe('本机改的（冲突副本）');
  });

  it('③ 恢复前已被彻底删除：回 not_found，恢复项丢掉；rejected 事件 code = not_found、item.op_id 是恢复项', async () => {
    const { outbox, t, id } = await goneTodo();
    const opId = await restore(outbox, 'todos', id);
    t.server.hardDelete('todos', id);
    const seen: OutboxEvent[] = [];
    outbox.onEvent((e) => seen.push(e));
    await sendAll(deps(outbox, t));
    const rejected = seen.filter((e): e is Extract<OutboxEvent, { type: 'rejected' }> => e.type === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: 'not_found' });
    expect(rejected[0]?.item.op_id).toBe(opId);
    expect(await outbox.list()).toEqual([]);
  });
});
