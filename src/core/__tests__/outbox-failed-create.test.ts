// R-378（接手清单 OUTBOX-failed-create-drops-edits）：新建那一项永久失败进 failed 以后，同一条记录后面的修改不能照样发出去
// （服务器上没有这一行，apply_patch 回 not_found，修改被丢），本机也不能把这一行连同后面的修改一起回滚掉：
// • sendOrder：有 failed 的 insert 的记录整条挡住，依赖它的记录一起挡；后面的项留在 pending（不变 failed），之后的编辑照样合并进来
// • rebaseView：failed 的 insert 照样叠加（行留在列表里），failed 的 patch 照旧不叠
// • 状态：这条记录算进 remindRecs（“未同步”），insert 能重试的同时算进 retryRecs
// • 重试：insert 改回 pending，seq 不变，先发 insert、确认后后面 patch 的 base_rev 从 null 推进成 rev
import { beforeEach, describe, expect, it } from 'vitest';
import { rebaseView, sendOrder } from '../outbox-logic.ts';
import { clearAllCollections } from '../store.ts';
import { clock, mk, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

const rec = (n: number): string => `todos:${uid(n)}`;

describe('sendOrder / rebaseView（纯函数）', () => {
  it('同一条记录有 failed 的 insert：后面的 patch 不发；依赖它的记录也不发；别的记录照常', () => {
    const items = [
      mk({ seq: 1, id: uid(1), op: 'insert', state: 'failed', error: 'http_400' }),
      mk({ seq: 2, id: uid(1), op: 'patch', data: { title: '改' } }),
      mk({ seq: 3, table: 'notes', id: uid(2), op: 'insert', deps: [{ table: 'todos', id: uid(1) }] }),
      mk({ seq: 4, id: uid(3), op: 'patch' }),
    ];
    expect(sendOrder(items, clock.t).map((i) => i.seq)).toEqual([4]);
  });

  it('failed 的 patch 照旧不挡后面的项', () => {
    const items = [mk({ seq: 1, id: uid(1), op: 'patch', state: 'failed', error: '23503' }), mk({ seq: 2, id: uid(1), op: 'patch' })];
    expect(sendOrder(items, clock.t).map((i) => i.seq)).toEqual([2]);
  });

  it('view：failed 的 insert 照样叠加，后面的 patch 叠在上面；failed 的 patch 不叠', () => {
    const items = [
      mk({ seq: 1, id: uid(1), op: 'insert', state: 'failed', error: 'http_400', data: { id: uid(1), title: '新建', note: '' } }),
      mk({ seq: 2, id: uid(1), op: 'patch', data: { title: '改了' } }),
      mk({ seq: 3, id: uid(1), op: 'patch', state: 'failed', error: '23503', data: { note: '失败的' } }),
    ];
    expect(rebaseView(null, items)).toEqual({ id: uid(1), title: '改了', note: '' });
  });
});

describe('真 outbox', () => {
  async function failedCreate(code: string, status = 400) {
    const s = await setup();
    await s.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const ins = await s.outbox.next();   // 在途：后面的修改是新的一项
    await s.outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改一' } });
    expect(await s.outbox.fail(ins?.op_id ?? '', { status, code, sid: null })).toBe('permanent');
    return { ...s, ins };
  }

  it('新建永久失败：行和后面的修改都留在本机；后面的项不发、不变 failed；之后的编辑照样能写、合并', async () => {
    const { cache, outbox } = await failedCreate('http_400');
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('改一');
    expect(await outbox.next()).toBeNull();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改二' } });
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('改二');
    const list = await outbox.list();
    expect(list.map((i) => [i.op, i.state])).toEqual([['insert', 'failed'], ['patch', 'pending']]);
    expect(await outbox.next()).toBeNull();
  });

  it('状态：算进“未同步”（remindRecs，不带提醒也算）；insert 能重试的算进 retryRecs，不能重试的码不算', async () => {
    const a = await failedCreate('http_400');
    expect(a.outbox.getStatus().remindRecs).toEqual(new Set([rec(1)]));
    expect(a.outbox.getStatus().retryRecs).toEqual(new Set([rec(1)]));
    const b = await failedCreate('insert_conflict', 409);
    expect(b.outbox.getStatus().remindRecs).toEqual(new Set([rec(1)]));
    expect(b.outbox.getStatus().retryRecs.size).toBe(0);
  });

  it('重试：先发 insert；确认后后面的 patch 的 base_rev 推进成 insert 的 rev，再发 patch；发完移出“未同步”', async () => {
    const { outbox, ins } = await failedCreate('http_400');
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改二' } });
    await outbox.retryFailed();
    const first = await outbox.next();
    expect(first?.op_id).toBe(ins?.op_id);
    expect(first?.op).toBe('insert');
    await outbox.ack(first?.op_id ?? '', { status: 'ok', rev: 3, prev_rev: null });
    const second = await outbox.next();
    expect(second).toMatchObject({ op: 'patch', base_rev: 3, data: { title: '改二' } });
    await outbox.ack(second?.op_id ?? '', { status: 'ok', rev: 4, prev_rev: 3 });
    expect(await outbox.list()).toEqual([]);
    expect(outbox.getStatus().remindRecs.size).toBe(0);
  });
});
