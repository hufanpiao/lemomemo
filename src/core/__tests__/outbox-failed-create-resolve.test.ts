// R-378：新建永久失败、码不能重试（insert_conflict 等）时的两个出路，core/outbox-failed-create.ts 的 resolveFailedCreateImpl：
// • copy（另存为新的一条）：换新 id，把失败的 insert 和后面还没发的修改按顺序合成一个 insert；旧记录的项和本机行删掉
// • drop（放弃）：删掉这条记录的全部项和本机行，依赖它的项一起删（cancelDependents）
import { beforeEach, describe, expect, it } from 'vitest';
import { OUTBOX } from '../cache-schema.ts';
import { resolveFailedCreateImpl } from '../outbox-failed-create.ts';
import type { OutboxItem } from '../outbox-types.ts';
import { outboxCtx, type Outbox } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { clock, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

const NEW = uid(50);

async function failedCreate(remind = false) {
  const s = await setup();
  await s.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1), remind });
  const ins = await s.outbox.next();
  await s.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改一' } });
  await s.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { note: '备注' } });
  await s.outbox.fail(ins?.op_id ?? '', { status: 409, code: 'insert_conflict', sid: null });
  return s;
}

function ctxOf(outbox: Outbox) {
  const ctx = outboxCtx.get(outbox);
  if (!ctx) throw new Error('outboxCtx');
  return ctx;
}

function run(outbox: Outbox, mode: 'copy' | 'drop', table = 'todos', id = uid(1)) {
  return resolveFailedCreateImpl(ctxOf(outbox), table, id, mode, NEW);
}

describe('另存为新的一条（copy）', () => {
  it('合成一个新 id 的 insert（带上后面的修改、保留提醒标记），旧的项和本机行删掉；新的一项能发', async () => {
    const { cache, outbox } = await failedCreate(true);
    expect(await run(outbox, 'copy')).toEqual({ done: 'copied', id: NEW });
    const list = await outbox.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ op: 'insert', id: NEW, state: 'pending', remind: true, data: { ...todo(1), id: NEW, title: '改一', note: '备注' } });
    expect(await cache.getRow('todos', uid(1))).toBeUndefined();
    expect((await cache.getRow('todos', NEW))?.view?.['title']).toBe('改一');
    expect((await outbox.next())?.id).toBe(NEW);
    expect(outbox.getStatus().remindRecs).toEqual(new Set([`todos:${NEW}`]));
  });

  it('用户后来把它删了（deleted_at）：不另存，按放弃处理', async () => {
    const { cache, outbox } = await failedCreate();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { deleted_at: 5 } });
    expect(await run(outbox, 'copy')).toEqual({ done: 'dropped', id: null });
    expect(await outbox.list()).toEqual([]);
    expect(await cache.getRow('todos', NEW)).toBeUndefined();
  });

  it('有别的记录依赖它：拒收 has_dependents，什么都不动（只能放弃）', async () => {
    const { outbox } = await failedCreate();
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2), deps: [{ table: 'todos', id: uid(1) }] });
    const before = await outbox.list();
    await expect(run(outbox, 'copy')).rejects.toMatchObject({ code: 'has_dependents' });
    expect(await outbox.list()).toEqual(before);
  });

  it('带上原各项 deps 的并集（去重）', async () => {
    const s = await setup();
    const dep = { table: 'todos', id: uid(9) };
    await s.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1), deps: [dep] });
    const ins = await s.outbox.next();
    await s.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改一' }, deps: [dep, { table: 'todos', id: uid(8) }] });
    await s.outbox.fail(ins?.op_id ?? '', { status: 409, code: 'insert_conflict', sid: null });
    expect((await run(s.outbox, 'copy')).done).toBe('copied');
    expect((await s.outbox.list())[0]?.deps).toEqual([dep, { table: 'todos', id: uid(8) }]);
  });

  it('settings 不另存（按 (user_id,key) 唯一，换 id 照样 23505）：按放弃处理（代码审查必改 1）', async () => {
    const s = await setup();
    const SID = uid(7);
    await s.outbox.enqueue({ table: 'settings', id: SID, op: 'insert', data: { id: SID, key: 'ui.theme', value: 'dark' } });
    const ins = await s.outbox.next();
    await s.outbox.fail(ins?.op_id ?? '', { status: 409, code: '23505', sid: null });
    expect(await run(s.outbox, 'copy', 'settings', SID)).toEqual({ done: 'dropped', id: null });
    expect(await s.outbox.list()).toEqual([]);
    expect(await s.cache.getRow('settings', SID)).toBeUndefined();
    expect(await s.cache.getRow('settings', NEW)).toBeUndefined();
  });

  it('有在途（inflight）的项：什么也不做（代码审查必改 3）', async () => {
    const { cache, outbox } = await failedCreate();
    const items = await outbox.list();
    const patch = items.find((i) => i.op === 'patch');
    await cache.tx([OUTBOX], 'readwrite', async (t) => {
      await t.put(OUTBOX, { ...patch, state: 'inflight' } as OutboxItem);
    });
    const before = await outbox.list();
    expect(await run(outbox, 'copy')).toEqual({ done: 'nothing', id: null });
    expect(await run(outbox, 'drop')).toEqual({ done: 'nothing', id: null });
    expect(await outbox.list()).toEqual(before);
  });

  it('第 1 步和写事务之间又写了新的修改（重读到的项不一样）：什么也不做（代码审查必改 3）', async () => {
    const { cache, outbox } = await failedCreate();
    const ctx = ctxOf(outbox);
    let calls = 0;
    // 第二次进事务（写事务）之前插一次写入，模拟另一个标签页在两步之间改了这条记录
    const racing = {
      ...ctx,
      cache: new Proxy(ctx.cache, {
        get(target, prop, recv) {
          if (prop !== 'tx') return Reflect.get(target, prop, recv);
          return async (...args: Parameters<typeof target.tx>) => {
            if (++calls === 2) await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '又改' } });
            return target.tx(...args);
          };
        },
      }),
    };
    expect(await resolveFailedCreateImpl(racing, 'todos', uid(1), 'copy', NEW)).toEqual({ done: 'nothing', id: null });
    expect(calls).toBe(2);
    const list = await outbox.list();
    // 后写的 patch 合并进已排队的那一项（op_id 不变）：只比 op_id 会漏掉，“又改”就丢了
    expect(list.map((i) => i.op)).toEqual(['insert', 'patch']);
    expect(list[1]?.data).toMatchObject({ title: '又改', note: '备注' });
    expect(await cache.getRow('todos', NEW)).toBeUndefined();
  });

  // 下面两条各拦一处 key() 的比对（R-378 复查建议：变异实测单独去掉 state、单独去掉 deps 都没被拦住）
  /** 第二次进事务（写事务）之前先跑 between：模拟两步之间别的地方动了这条记录 */
  function racingCtx(outbox: Outbox, between: () => Promise<void>) {
    const ctx = ctxOf(outbox);
    let calls = 0;
    return {
      ...ctx,
      cache: new Proxy(ctx.cache, {
        get(target, prop, recv) {
          if (prop !== 'tx') return Reflect.get(target, prop, recv);
          return async (...args: Parameters<typeof target.tx>) => {
            if (++calls === 2) await between();
            return target.tx(...args);
          };
        },
      }),
    };
  }

  for (const mode of ['copy', 'drop'] as const) {
    it(`${mode}：两步之间用户点了重试、那一项已经在发（只有 state 变了）：什么也不做，不删在途的项`, async () => {
      const { cache, outbox } = await failedCreate();
      const before = await outbox.list();
      const ins = before.find((i) => i.op === 'insert');
      const racing = racingCtx(outbox, async () => {
        await cache.tx([OUTBOX], 'readwrite', async (t) => {
          await t.put(OUTBOX, { ...ins, state: 'inflight' } as OutboxItem);
        });
      });
      expect(await resolveFailedCreateImpl(racing, 'todos', uid(1), mode, NEW)).toEqual({ done: 'nothing', id: null });
      const list = await outbox.list();
      expect(list).toEqual(before.map((i) => (i.op_id === ins?.op_id ? { ...i, state: 'inflight' } : i)));
      expect(await cache.getRow('todos', NEW)).toBeUndefined();
    });
  }

  it('两步之间后面的修改多了一个依赖（只有 deps 变了，data 不变）：什么也不做，不丢这个依赖', async () => {
    const { cache, outbox } = await failedCreate();
    const before = await outbox.list();
    const dep = { table: 'todos', id: uid(9) };
    const racing = racingCtx(outbox, async () => {
      await cache.tx([OUTBOX], 'readwrite', async (t) => {
        await t.put(OUTBOX, { ...before.at(-1), deps: [dep] } as OutboxItem);
      });
    });
    expect(await resolveFailedCreateImpl(racing, 'todos', uid(1), 'copy', NEW)).toEqual({ done: 'nothing', id: null });
    const list = await outbox.list();
    expect(list.map((i) => i.op_id)).toEqual(before.map((i) => i.op_id));
    expect(list.at(-1)?.deps).toEqual([dep]);
    expect(list.at(-1)?.data).toEqual(before.at(-1)?.data);
    expect(await cache.getRow('todos', NEW)).toBeUndefined();
  });

  it('没有失败的 insert：什么也不做', async () => {
    const { outbox } = await setup();
    expect(await run(outbox, 'copy')).toEqual({ done: 'nothing', id: null });
  });
});

describe('放弃（drop）', () => {
  it('删掉这条记录的全部项和本机行，依赖它的项一起删；别的记录不动', async () => {
    const { cache, outbox } = await failedCreate();
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2), deps: [{ table: 'todos', id: uid(1) }] });
    await outbox.enqueue({ table: 'todos', id: uid(3), op: 'insert', data: todo(3) });
    expect(await run(outbox, 'drop')).toEqual({ done: 'dropped', id: null });
    expect((await outbox.list()).map((i) => i.id)).toEqual([uid(3)]);
    expect(await cache.getRow('todos', uid(1))).toBeUndefined();
    expect(await cache.getRow('todos', uid(2))).toBeUndefined();
    expect(outbox.getStatus().remindRecs.size).toBe(0);
  });
});
