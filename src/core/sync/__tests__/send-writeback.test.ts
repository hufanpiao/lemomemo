// 回包写回（ack、fail）抛错时这一项不能留在 inflight（outbox.next() 见到 inflight 就不发，整个队列卡到下次启动）：
// 退回 pending、记 sync_writeback_failed，再把错误抛给引擎（CacheClosedError 照旧当停下）
import { describe, expect, it, vi } from 'vitest';
import { seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { sendAll } from '../send.ts';
import { fakeTransport } from './fake-server.ts';

async function queued() {
  const { cache, outbox } = await setup();
  const t = fakeTransport();
  const row = t.server.insert('todos', todo(1));
  await seed(cache, 'todos', uid(1), todo(1), row.rev);
  await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
  return { outbox, t };
}
type Q = Awaited<ReturnType<typeof queued>>;
const deps = ({ outbox, t }: Q, log = vi.fn()) => ({
  outbox, transport: t, gated: () => false, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined, log,
});

describe('回包写回抛错不卡队列', () => {
  it('ack 抛错：这一项退回 pending（带 sent），记 sync_writeback_failed；下一轮照常发出、确认', async () => {
    const q = await queued();
    const ack = q.outbox.ack.bind(q.outbox);
    q.outbox.ack = vi.fn(async () => {
      throw new Error('boom');
    });
    const log = vi.fn();
    await expect(sendAll(deps(q, log))).rejects.toThrow('boom');
    expect((await q.outbox.list())[0]).toMatchObject({ state: 'pending', sent: true });
    expect(log).toHaveBeenCalledWith('sync_writeback_failed', { coll: 'todos', code: 'Error' });
    q.outbox.ack = ack;
    expect(await sendAll(deps(q))).toBe('done');
    expect(await q.outbox.list()).toEqual([]);
  });

  it('fail 抛错：同样退回 pending', async () => {
    const q = await queued();
    q.t.applyPatch = async () => ({ ok: false, error: { status: 503 } });
    q.outbox.fail = vi.fn(async () => {
      throw new DOMException('tx', 'AbortError');
    });
    await expect(sendAll(deps(q))).rejects.toThrow();
    expect((await q.outbox.list())[0]).toMatchObject({ state: 'pending', sent: true });
  });
});
