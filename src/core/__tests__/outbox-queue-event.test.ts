// outbox 的 queue 事件（OUTBOX-cross-tab）：本页真改了队列就发一次，待发数不变也发；只有主页引擎调的 ack、fail、applyServer、dropServer 不发。
// app/sync-wiring 的非主页靠它提醒主页（两页接线的用例在 app/__tests__/sync-tabs-queue.test.ts）
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveGoneImpl } from '../outbox-gone.ts';
import { outboxCtx, type Outbox } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

const ID = uid(1);

function count(outbox: Outbox): () => number {
  let n = 0;
  outbox.onEvent((e) => {
    if (e.type === 'queue') n++;
  });
  return () => n;
}

describe('queue 事件', () => {
  it('新写入、合并进已排队的 patch（待发数不变）、撤销抵消 insert：各发一次', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', ID, todo(1));
    const n = count(outbox);
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: '一' } });
    expect(n()).toBe(1);
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: '二' } });
    expect(outbox.getStatus().pending).toBe(1);
    expect(n()).toBe(2);
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { undone: true } });
    expect(n()).toBe(4);
  });

  it('clearBackoff、retryFailed、discard、discardUnlessInflight（删成了才发）、resume：各发一次', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', ID, todo(1));
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: '一' } });
    const n = count(outbox);
    const sent = await outbox.next();
    await outbox.fail(sent?.op_id ?? '', { network: true, sid: null });   // 断网：退避
    expect(n()).toBe(0);
    await outbox.clearBackoff();
    expect(n()).toBe(1);
    const again = await outbox.next();
    await outbox.fail(again?.op_id ?? '', { status: 400, code: 'bad_request', sid: null });   // 永久失败
    expect(outbox.getStatus().failed).toBe(1);
    await outbox.retryFailed();
    expect(n()).toBe(2);
    await outbox.retryFailed();   // 没有可重试的：不发
    expect(n()).toBe(2);
    const inflight = await outbox.next();
    expect(await outbox.discardUnlessInflight(inflight?.op_id ?? '')).toBe(false);
    expect(n()).toBe(2);
    await outbox.resetInflight();
    expect(await outbox.discardUnlessInflight(inflight?.op_id ?? '')).toBe(true);
    expect(n()).toBe(3);
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: '二' } });
    const [last] = await outbox.list();
    await outbox.discard(last?.op_id ?? '');
    expect(n()).toBe(5);
    await outbox.resume();
    expect(n()).toBe(6);
  });

  it('ack、applyServer、dropServer 不发（只有主页的引擎调）', async () => {
    const { outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: ID, op: 'insert', data: todo(1) });
    const n = count(outbox);
    const it1 = await outbox.next();
    await outbox.ack(it1?.op_id ?? '', { status: 'ok', rev: 1, prev_rev: null });
    await outbox.applyServer('todos', [{ row: { ...todo(1), id: ID, rev: 2 } }]);
    await outbox.dropServer('todos', [ID]);
    expect(n()).toBe(0);
  });

  it('resolveGone 收尾也发', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', ID, todo(1), 7);
    await outbox.enqueue({ table: 'todos', id: ID, op: 'patch', data: { title: '一' } });
    const sent = await outbox.next();
    await outbox.fail(sent?.op_id ?? '', { status: 409, code: 'gone', sid: null });
    const n = count(outbox);
    const ctx = outboxCtx.get(outbox);
    if (!ctx) throw new Error('outboxCtx');
    expect((await resolveGoneImpl(ctx, 'todos', ID, 'drop')).done).toBe('dropped');
    expect(n()).toBe(1);
  });
});
