// core/outbox-gone.ts 的 resolveGoneImpl（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.3 的单测清单；复审一 R2 ①～④）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cache, CacheTx, CachedRow } from '../cache.ts';
import { OUTBOX } from '../cache-schema.ts';
import { resolveGoneImpl } from '../outbox-gone.ts';
import { OutboxRejectError, outboxCtx, type Outbox, type OutboxItem, type ResolveGoneOptions } from '../outbox.ts';
import { clearAllCollections, collection } from '../store.ts';
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

describe('restore', () => {
  it('同一条记录两个 gone 项（H1）：合并成一项 pending patch 入队（带 deleted_at: null），两项都删；view 回来', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await goneOf(outbox, { note: 'B' });
    await seedDeleted(cache);
    expect((await items(outbox)).map((i) => i.error)).toEqual(['gone', 'gone']);

    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('restored');
    const list = await items(outbox);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ op: 'patch', state: 'pending', error: null, base_rev: 7, data: { title: 'A', note: 'B', deleted_at: null } });
    expect(list[0]?.sent).toBeUndefined();
    const row = await cache.getRow('todos', ID);
    expect(row?.view).toMatchObject({ title: 'A', note: 'B', deleted_at: null });
    expect(collection('todos').get(ID)?.['title' as never]).toBe('A');
    expect(outbox.getStatus()).toMatchObject({ pending: 1, failed: 0 });
  });

  it('跟随组（R2 ②）：gone 之后还没发出的 patch 并进恢复项、一起删；已发出（sent）的不动', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { note: '之后又存了一次' } });
    await seedDeleted(cache);
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('restored');
    const list = await items(outbox);
    expect(list).toHaveLength(1);
    expect(list[0]?.data).toEqual({ title: 'A', note: '之后又存了一次', deleted_at: null });

    // 已发出的跟随项：留着，不并进来
    const b = await setup();
    await seedDeleted(b.cache, { deleted_at: null });
    await goneOf(b.outbox, { title: 'A' });
    await b.outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { note: '在途' } });
    const inflight = await b.outbox.next();
    expect(inflight?.data).toEqual({ note: '在途' });
    expect((await rg(b.outbox, 'todos', ID, 'restore')).done).toBe('restored');
    const left = await items(b.outbox);
    expect(left.map((i) => i.op_id)).toContain(inflight?.op_id);
    expect(left.find((i) => i.op_id !== inflight?.op_id)?.data).toEqual({ title: 'A', deleted_at: null });
  });

  it('服务器行 undone 为 true（M1）：恢复 patch 再加 undone: false', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache, { undone: true });
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('restored');
    expect((await items(outbox))[0]?.data).toEqual({ title: 'A', deleted_at: null, undone: false });
  });

  it('合并后 undone === true（R2 ④）：restore 拒收 undone，队列不变', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { undone: true });
    await seedDeleted(cache);
    const before = await items(outbox);
    await expect(rg(outbox, 'todos', ID, 'restore')).rejects.toMatchObject({ code: 'undone' });
    expect(await items(outbox)).toEqual(before);
  });

  it('只读行拒收 readonly_row；队列、view 不变', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    await cache.tx(['todos'], 'readwrite', async (t) => {
      const r = await t.get<CachedRow>('todos', ID);
      if (r) await t.put('todos', { ...r, ro: true });
    });
    const before = await items(outbox);
    const view = (await cache.getRow('todos', ID))?.view;
    await expect(rg(outbox, 'todos', ID, 'restore')).rejects.toBeInstanceOf(OutboxRejectError);
    await expect(rg(outbox, 'todos', ID, 'restore')).rejects.toMatchObject({ code: 'readonly_row' });
    expect(await items(outbox)).toEqual(before);
    expect((await cache.getRow('todos', ID))?.view).toEqual(view);
  });

  it('严格校验不过（M8）：抛严格校验的码，不入队', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    // 队列里的旧项带了一个现在的严格版不认的值（例如老版本写进去的）
    await cache.tx([OUTBOX], 'readwrite', async (t) => {
      const [g] = await t.getAll<OutboxItem>(OUTBOX);
      if (g) await t.put(OUTBOX, { ...g, data: { title: 42 } });
    });
    await expect(rg(outbox, 'todos', ID, 'restore')).rejects.toMatchObject({ code: 'invalid_row' });
    expect(await items(outbox)).toHaveLength(1);
  });

  it('remindOf（M7）：拿到 view 叠上恢复 patch 的整行和 patch 本身，结果写进 remind', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    const remindOf = vi.fn(() => true);
    expect((await rg(outbox, 'todos', ID, 'restore', { remindOf })).done).toBe('restored');
    expect(remindOf).toHaveBeenCalledWith(expect.objectContaining({ id: ID, title: 'A', deleted_at: null, remind_time: '09:00' }), { title: 'A', deleted_at: null });
    expect((await items(outbox))[0]?.remind).toBe(true);
    expect(outbox.getStatus().remindRecs.has(`todos:${ID}`)).toBe(true);
  });

  it('newItem 的规则（R2 ①）：op_id、seq 取全队列最大值加 1、client_ts 取 now、v、app', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    await seed(cache, 'todos', uid(2), todo(2), 3);
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '别的' } });
    clock.t = 2_000_000;
    await rg(outbox, 'todos', ID, 'restore');
    const mine = (await items(outbox)).find((i) => i.id === ID);
    expect(mine).toMatchObject({ seq: 3, client_ts: 2_000_000, v: 1, app: '4.0.0', tries: 0, next_at: 0, own_revs: [] });
    expect(mine?.op_id).toMatch(/^op-/);
  });
});

describe('返回值', () => {
  it('restored 带恢复项的 op_id（冲突提示按它认“刚恢复”的那一项，复审四 L1）；dropped、nothing 为 null', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    const r = await rg(outbox, 'todos', ID, 'restore');
    expect(r.opId).toBe((await items(outbox))[0]?.op_id);
    expect(await rg(outbox, 'todos', ID, 'drop')).toEqual({ done: 'nothing', opId: null });
    const b = await setup();
    await seedDeleted(b.cache, { deleted_at: null });
    await goneOf(b.outbox, { title: 'A' });
    expect(await rg(b.outbox, 'todos', ID, 'drop')).toEqual({ done: 'dropped', opId: null });
  });
});

describe('drop', () => {
  it('只删 gone 组，跟随组不动；行留在软删状态', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { note: '之后' } });
    await seedDeleted(cache);
    expect((await rg(outbox, 'todos', ID, 'drop')).done).toBe('dropped');
    const list = await items(outbox);
    expect(list).toHaveLength(1);
    expect(list[0]?.data).toEqual({ note: '之后' });
    expect((await cache.getRow('todos', ID))?.view).toMatchObject({ deleted_at: 900_000, note: '之后' });
  });

  it('不校验：合并后是撤销也照样 drop', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { undone: true });
    await seedDeleted(cache);
    expect((await rg(outbox, 'todos', ID, 'drop')).done).toBe('dropped');
    expect(await items(outbox)).toEqual([]);
  });
});

describe('并发和变化（R2 ③、M2）', () => {
  it('没有 gone 项：nothing，什么也不改', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', ID, todo(1), 7);
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: 'A' } });
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('nothing');
    expect((await rg(outbox, 'todos', ID, 'drop')).done).toBe('nothing');
    expect(await items(outbox)).toHaveLength(1);
  });

  /** 在 resolveGone 的写事务开始前（第 1 步之后）往队列里插一项 gone，模拟别的标签页；times 次 */
  function interfere(cache: Cache, times: number): () => number {
    const real = cache.tx.bind(cache);
    let left = times;
    let n = 0;
    vi.spyOn(cache, 'tx').mockImplementation((async (stores: string[], mode: IDBTransactionMode, fn: (t: CacheTx) => Promise<unknown>) => {
      if (left > 0 && mode === 'readwrite' && stores.includes(OUTBOX) && stores.includes('todos')) {
        left--;
        n++;
        await real([OUTBOX], 'readwrite', async (t) => {
          const all = await t.getAll<OutboxItem>(OUTBOX);
          const g = all.find((i) => i.error === 'gone');
          if (g) await t.put(OUTBOX, { ...g, op_id: `extra-${n}`, seq: Math.max(...all.map((i) => i.seq)) + 1, data: { note: `别的标签页${n}` } });
        });
      }
      return real(stores, mode, fn);
    }) as typeof cache.tx);
    return () => n;
  }

  it('写事务里集合变了：回滚、重读一次后成功（新来的 gone 也并进来）', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    const n = interfere(cache, 1);
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('restored');
    expect(n()).toBe(1);
    const list = await items(outbox);
    expect(list).toHaveLength(1);
    expect(list[0]?.data).toEqual({ title: 'A', note: '别的标签页1', deleted_at: null });
  });

  it('连续两次都变了：nothing；第二次写事务整个回滚，队列里只有原来的和插进来的 gone，没有恢复项', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    const g = await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    const view = (await cache.getRow('todos', ID))?.view;
    interfere(cache, 2);
    expect((await rg(outbox, 'todos', ID, 'restore')).done).toBe('nothing');
    const list = await items(outbox);
    expect(list.map((i) => i.op_id).sort()).toEqual([g.op_id, 'extra-1', 'extra-2'].sort());
    expect(list.every((i) => i.error === 'gone')).toBe(true);
    expect((await cache.getRow('todos', ID))?.view).toEqual(view);
  });

  it('两个“标签页”同时点，一个 restore、一个 drop：只有一个生效，另一个 nothing', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    const [a, b] = (await Promise.all([rg(outbox, 'todos', ID, 'restore'), rg(outbox, 'todos', ID, 'drop')])).map((r) => r.done);
    expect([a, b].filter((r) => r === 'nothing')).toHaveLength(1);
    const list = await items(outbox);
    expect(list.filter((i) => i.error === 'gone')).toEqual([]);
    if (a === 'restored') expect(list).toHaveLength(1);
    else expect(list).toEqual([]);
  });
});

describe('闸和关库', () => {
  it('设了闸：outbox_suspended，不改队列', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    outbox.suspend();
    await expect(rg(outbox, 'todos', ID, 'restore')).rejects.toMatchObject({ code: 'outbox_suspended' });
    await expect(rg(outbox, 'todos', ID, 'drop')).rejects.toMatchObject({ code: 'outbox_suspended' });
  });

  it('库关了：抛 CacheClosedError（write-gone 映射成 closing）', async () => {
    const { cache, outbox } = await setup();
    await seedDeleted(cache, { deleted_at: null });
    await goneOf(outbox, { title: 'A' });
    await seedDeleted(cache);
    cache.close();
    await expect(rg(outbox, 'todos', ID, 'drop')).rejects.toMatchObject({ name: 'CacheClosedError' });
  });
});
