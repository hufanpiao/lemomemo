// 离线队列返工（K6 审查 M6、L2、L10）：确认时中间夹了别的设备写入不回滚界面；forked 只合并 title、body 以外的列；
// 失败分类（被移除、not_found 丢掉）；insert 被撤销抵消时依赖它的项一起抵消（含别的表）
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyFailure } from '../outbox.ts';
import { clearAllCollections, collection } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('M6：确认时中间夹了别的设备的写入', () => {
  it('界面不回滚刚确认的修改：server 叠上这次的修改、rev 保持旧值，own_revs 加上 ack.rev；新行到了再整行替换', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '我改的' } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 9, prev_rev: 8 });   // 6～8 是别的设备写的
    const r = await cache.getRow('todos', uid(1));
    expect(r?.server).toMatchObject({ title: '我改的', rev: 5 });
    expect(r?.view).toMatchObject({ title: '我改的' });
    expect(r?.own_revs).toEqual([9]);
    expect(collection<{ id: string; title?: string }>('todos').get(uid(1))?.title).toBe('我改的');

    await outbox.applyServer('todos', [{ row: { ...todo(1), id: uid(1), title: '我改的', note: '别人改的', rev: 9 } }]);
    const r2 = await cache.getRow('todos', uid(1));
    expect(r2?.view).toMatchObject({ title: '我改的', note: '别人改的', rev: 9 });
    expect(r2?.own_revs).toBeUndefined();
  });

  it('forked：只合并 title、body 以外的列（这两列另存成了冲突副本）；中间没人写过时 rev 推进', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '新标题', important: true } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'forked', rev: 6, prev_rev: 5 });
    const r = await cache.getRow('todos', uid(1));
    expect(r?.server).toMatchObject({ title: '待办1', important: true, rev: 6 });
    expect(r?.view).toMatchObject({ title: '待办1', important: true });

    // 中间夹了别的设备的写入时同样只合并 title、body 以外的列
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '又改', note: 'n' } });
    const b = await outbox.next();
    await outbox.ack(b?.op_id ?? '', { status: 'forked', rev: 9, prev_rev: 8 });
    expect((await cache.getRow('todos', uid(1)))?.server).toMatchObject({ title: '待办1', note: 'n', rev: 6 });
  });
});

describe('L2：失败分类', () => {
  it('session_revoked 走“被移除”；account_disabled 走“被停用”（4.4.1 照 4.3、不丢队列）；apply_patch 的 not_found 丢掉；令牌过期仍是 auth', () => {
    expect(classifyFailure({ status: 401, code: 'session_revoked' })).toBe('removed');
    expect(classifyFailure({ status: 403, code: 'account_disabled' })).toBe('disabled');
    expect(classifyFailure({ status: 400, code: 'account_disabled' })).toBe('disabled');
    expect(classifyFailure({ status: 404, code: 'not_found' })).toBe('drop');
    expect(classifyFailure({ status: 401, code: 'jwt_expired' })).toBe('auth');
  });

  it('not_found：丢掉这一项、回滚、发 rejected 事件', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    const events: string[] = [];
    outbox.onEvent((e) => events.push(e.type));
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
    const a = await outbox.next();
    expect(await outbox.fail(a?.op_id ?? '', { status: 404, code: 'not_found', sid: null })).toBe('drop');
    expect(await outbox.list()).toEqual([]);
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('待办1');
    expect(events).toEqual(['rejected']);
  });
});

describe('account_disabled、account_pending_deletion：被停用、注销冷静期（4.3、4.3b、0.29 续第 131 条②）', () => {
  it('归成 disabled：队列设闸停发、不回滚、不写库；只发 disabled 事件（带 code），清本机由调用方做（和 removed 同一套）', async () => {
    expect(classifyFailure({ status: 403, code: 'account_pending_deletion' })).toBe('disabled');
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    const events: string[] = [];
    outbox.onEvent((e) => events.push(`${e.type}:${'code' in e ? e.code : ''}`));
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '停用前改的' } });
    const a = await outbox.next();
    expect(await outbox.fail(a?.op_id ?? '', { status: 403, code: 'account_pending_deletion', sid: null })).toBe('disabled');
    expect(events).toEqual(['disabled:account_pending_deletion']);
    expect(outbox.isSuspended()).toBe(true);
    expect(await outbox.next()).toBeNull();
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('停用前改的');   // 不回滚（随后整库清掉）
  });

  it('OUTBOX-sid-type：fail 不带 sid 编不过（@ts-expect-error 由 typecheck 检查），带了就原样进事件', async () => {
    const { outbox } = await setup();
    const got: unknown[] = [];
    outbox.onEvent((e) => got.push(e));
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    const a = await outbox.next();
    const noSid = (): Promise<unknown> =>
      // @ts-expect-error 少了 sid
      outbox.fail(a?.op_id ?? '', { status: 403, code: 'account_disabled' });
    expect(typeof noSid).toBe('function');
    await outbox.fail(a?.op_id ?? '', { status: 403, code: 'account_disabled', sid: 's7' });
    expect(got).toEqual([{ type: 'disabled', code: 'account_disabled', sid: 's7' }]);
  });
});

describe('L10：insert 被撤销抵消时，依赖它的项一起抵消', () => {
  it('依赖它的 insert 整条丢掉并继续往下传（含别的表）；依赖它的 patch 只丢这一项；不相干的不动', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(3), todo(3), 5);
    await seed(cache, 'todos', uid(4), todo(4), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    // uid(2) 依赖 uid(1)（insert + 后续 patch）
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2), deps: [{ table: 'todos', id: uid(1) }] });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '二改' } });
    // 别的表的 insert 依赖 uid(2)：随 uid(2) 一起丢
    await outbox.enqueue({ table: 'categories', id: uid(7), op: 'insert', data: { id: uid(7), name: '分类' }, deps: [{ table: 'todos', id: uid(2) }] });
    // uid(3) 的 patch 依赖 uid(2)：只丢这一项，view 回到 server
    await outbox.enqueue({ table: 'todos', id: uid(3), op: 'patch', data: { title: '三改' }, deps: [{ table: 'todos', id: uid(2) }] });
    // uid(4) 的 patch 不相干
    await outbox.enqueue({ table: 'todos', id: uid(4), op: 'patch', data: { title: '四改' } });

    expect(await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { undone: true } })).toBeNull();

    expect((await outbox.list()).map((i) => i.rec)).toEqual([`todos:${uid(4)}`]);
    expect(await cache.getRow('todos', uid(2))).toBeUndefined();
    expect(await cache.getRow('categories', uid(7))).toBeUndefined();
    expect((await cache.getRow('todos', uid(3)))?.view?.['title']).toBe('待办3');
    expect((await cache.getRow('todos', uid(4)))?.view?.['title']).toBe('四改');
    expect(collection('todos').get(uid(2))).toBeUndefined();
    expect(collection('categories').get(uid(7))).toBeUndefined();
    expect(collection<{ id: string; title?: string }>('todos').get(uid(3))?.title).toBe('待办3');
    expect(outbox.getStatus().pending).toBe(1);
  });
});
