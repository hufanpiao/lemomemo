// outbox.discardUnlessInflight（接手清单 K6-sugg4 ③）：“是不是正在发（inflight）”和“删”在同一个写事务里判断。
// core/ai-settings.ts 的 writeAiSwitchSettled 补写成功后用它删掉被拒的 insert；原先“先 list 查状态、再 discard”中间有间隙，
// 这期间 next() 把这一项取去发了（用户刚点了重试）也会被删
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllCollections } from '../store.ts';
import { clock, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

/** 入队一项、发出去、被服务器拒（进“发送失败”区），返回 op_id */
async function failedItem() {
  const { cache, outbox } = await setup();
  await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
  const a = await outbox.next();
  if (!a) throw new Error('next');
  await outbox.fail(a.op_id, { status: 409, code: '23505', sid: null });
  return { cache, outbox, opId: a.op_id };
}

/** 下一次写事务开始之前先跑 fn（= 查完状态、删之前那一刻插进来的事；确定的时序，不靠假 IndexedDB 的调度） */
function beforeNextWrite(cache: Awaited<ReturnType<typeof failedItem>>['cache'], fn: () => Promise<unknown>): void {
  const tx = cache.tx.bind(cache);
  let pending: (() => Promise<unknown>) | null = fn;
  cache.tx = (async (stores, mode, body) => {
    const run = pending;
    if (mode === 'readwrite' && run) {
      pending = null;
      await run();
    }
    return tx(stores, mode, body);
  }) as typeof cache.tx;
}

const stateOf = async (o: Awaited<ReturnType<typeof failedItem>>['outbox'], opId: string) =>
  ((await o.list()).find((i) => i.op_id === opId) ?? null)?.state ?? null;

describe('discardUnlessInflight', () => {
  it('发送失败区的一项：删掉，返回 true', async () => {
    const { outbox, opId } = await failedItem();
    expect(await stateOf(outbox, opId)).toBe('failed');
    expect(await outbox.discardUnlessInflight(opId)).toBe(true);
    expect(await stateOf(outbox, opId)).toBeNull();
    expect(outbox.getStatus().failed).toBe(0);
  });

  it('正在发（点了重试、next 取走了）：不删，返回 false；没有这一项也返回 false', async () => {
    const { outbox, opId } = await failedItem();
    await outbox.retryFailed([opId]);
    expect((await outbox.next())?.op_id).toBe(opId);
    expect(await outbox.discardUnlessInflight(opId)).toBe(false);
    expect(await stateOf(outbox, opId)).toBe('inflight');
    expect(await outbox.discardUnlessInflight('op-none')).toBe(false);
  });

  it('查状态之后、删之前被 next() 取去发：写事务里重新判断，不删', async () => {
    const { cache, outbox, opId } = await failedItem();
    await outbox.retryFailed([opId]);
    let sent: { op_id: string } | null = null;
    // discardUnlessInflight 先读到 pending；它的写事务开始前，next() 把这一项标成 inflight
    beforeNextWrite(cache, async () => (sent = await outbox.next()));
    const dropped = await outbox.discardUnlessInflight(opId);
    expect(sent).toMatchObject({ op_id: opId });
    expect(dropped).toBe(false);
    expect(await stateOf(outbox, opId)).toBe('inflight');
  });

  it('对照（修之前的写法：先 list 查状态、再 discard）：同样的时序会把正在发的那一项删掉', async () => {
    const { cache, outbox, opId } = await failedItem();
    await outbox.retryFailed([opId]);
    let sent: { op_id: string } | null = null;
    const cur = (await outbox.list()).find((i) => i.op_id === opId);
    expect(cur?.state).toBe('pending');
    beforeNextWrite(cache, async () => (sent = await outbox.next()));   // 同样的时序
    if (cur && cur.state !== 'inflight') await outbox.discard(opId);
    expect(sent).toMatchObject({ op_id: opId });
    expect(await stateOf(outbox, opId)).toBeNull();   // 这就是建议 ③ 说的间隙：在发的那一项没了
  });
});
