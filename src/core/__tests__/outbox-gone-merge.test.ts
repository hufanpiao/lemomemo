// core/outbox-gone.ts 的 resolveGoneImpl：代码审查补的几条（M1 合并走 mergePatch、N1 合并顺序、M2 deps 并集、S3 跟随组只收没发出过的）。
// 和 outbox-gone.test.ts 用同一套辅助函数（那边超 300 行，拆到这里）
import { beforeEach, describe, expect, it } from 'vitest';
import type { Cache } from '../cache.ts';
import { resolveGoneImpl } from '../outbox-gone.ts';
import { outboxCtx, type Outbox, type OutboxItem, type ResolveGoneOptions } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

const ID = uid(1);
const DELETED = { deleted_at: 900_000 };

/** 服务器上已软删的一行（另一台设备删的），本机还没拉到删除时的样子由 seed 给 */
async function seedDeleted(cache: Cache, over: Record<string, unknown> = {}): Promise<void> {
  await seed(cache, 'todos', ID, { ...todo(1), ...DELETED, ...over }, 7);
}

/** 入队一个 patch，发出去，服务器回 gone */
async function goneOf(outbox: Outbox, data: Record<string, unknown>): Promise<OutboxItem> {
  await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data });
  const sent = await outbox.next();
  if (!sent) throw new Error('next');
  await outbox.fail(sent.op_id, { status: 409, code: 'gone', sid: null });
  return sent;
}

const items = (outbox: Outbox) => outbox.list();

/** 同 core/write-gone.ts 的调法：ctx 从 outboxCtx 取 */
function rg(outbox: Outbox, table: string, id: string, mode: 'restore' | 'drop', opts?: ResolveGoneOptions) {
  const ctx = outboxCtx.get(outbox);
  if (!ctx) throw new Error('outboxCtx');
  return resolveGoneImpl(ctx, table, id, mode, opts);
}

describe('restore 的合并（代码审查 M1、M2、S3、N1）', () => {
  it('合并走 rows.mergePatch（代码审查 M1）：gone 组换了提醒、跟随组是旧提醒的“知道了”，恢复 patch 的 notified_for 仍是 null', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { remind_days: 1, notified_for: null });
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { notified_for: 1_700_000_000_000 } });
    await seedDeleted(cache);
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('restored');
    const list = await items(outbox);
    expect(list).toHaveLength(1);
    expect(list[0]?.data).toEqual({ remind_days: 1, notified_for: null, deleted_at: null });
  });

  it('合并顺序（复查 N1）：后写的赢——gone 项 title A、跟随项 title B → B；两个 gone 项改同一列 → 后一个', async () => {
    const a = await setup();
    await seedDeleted(a.cache, { deleted_at: null });
    await goneOf(a.outbox, { title: 'A' });
    await a.outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: 'B' } });
    await seedDeleted(a.cache);
    await rg(a.outbox, 'todos', ID, 'restore');
    expect((await items(a.outbox))[0]?.data).toEqual({ title: 'B', deleted_at: null });

    const b = await setup();
    await seedDeleted(b.cache, { deleted_at: null });
    await goneOf(b.outbox, { title: '先' });
    await goneOf(b.outbox, { title: '后' });
    await seedDeleted(b.cache);
    await rg(b.outbox, 'todos', ID, 'restore');
    expect((await items(b.outbox))[0]?.data).toEqual({ title: '后', deleted_at: null });
  });

  it('恢复项的 deps（代码审查 M2）：gone 组和跟随组 deps 的并集，去掉自己、去重', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    const C = { table: 'categories', id: uid(7) };
    const N = { table: 'notes', id: uid(8) };
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: 'A' }, deps: [C] });
    const sent = await outbox.next();
    if (!sent) throw new Error('next');
    await outbox.fail(sent.op_id, { status: 409, code: 'gone', sid: null });
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { note: 'B' }, deps: [N, C, { table: 'todos', id: ID }] });
    await seedDeleted(cache);
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('restored');
    const list = await items(outbox);
    expect(list).toHaveLength(1);
    expect(list[0]?.deps).toEqual([C, N]);
  });

  it('跟随组只收没发出过的（代码审查 S3）：pending 但 sent 为 true（resetInflight 复位过）的不并进来', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { note: '发过又复位' } });
    const inflight = await outbox.next();
    if (!inflight) throw new Error('next');
    await outbox.resetInflight(inflight.op_id);
    expect((await items(outbox)).find((i) => i.op_id === inflight.op_id)).toMatchObject({ state: 'pending', sent: true });
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('restored');
    const left = await items(outbox);
    expect(left.find((i) => i.op_id === inflight.op_id)?.data).toEqual({ note: '发过又复位' });
    expect(left.find((i) => i.op_id !== inflight.op_id)?.data).toEqual({ title: 'A', deleted_at: null });
  });
});
