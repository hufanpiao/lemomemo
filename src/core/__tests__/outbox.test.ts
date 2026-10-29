// 离线写入队列（架构 4.2、0.27 第 1 点、第七轮 S1）：TC-B1-27、TC-B1-42 和 4.2 的合并、抵消、推进 base_rev
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedRow } from '../cache.ts';
import { createOutbox, OutboxRejectError } from '../outbox.ts';
import { clearAllCollections, collection } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('入队', () => {
  it('insert：同一个事务里改 view、写队列；集合马上通知；状态计数', async () => {
    const { cache, outbox } = await setup();
    const listener = vi.fn();
    collection('todos').subscribe(listener);
    const item = await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    expect(item).toMatchObject({ op: 'insert', state: 'pending', v: 1, app: '4.0.0', base_rev: null, tries: 0, seq: 1 });
    const r = await cache.getRow('todos', uid(1));
    expect(r?.server).toBeNull();
    expect(r?.view?.['title']).toBe('待办1');
    expect(listener).toHaveBeenCalled();
    expect(collection('todos').get(uid(1))?.['title' as never]).toBe('待办1');
    expect(outbox.getStatus().pending).toBe(1);
  });

  it('patch：base_rev 取 server 的 rev；连续 patch 合并成一个（base_rev 不变）；inflight 的不参与合并', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'a' } });
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { note: 'b' } });
    let list = await outbox.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ base_rev: 5, data: { title: 'a', note: 'b' } });

    const sent = await outbox.next();
    expect(sent?.state).toBe('inflight');
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'c' } });
    list = await outbox.list();
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ base_rev: 5, data: { title: 'c' }, state: 'pending' });
    expect((await cache.getRow('todos', uid(1)))?.view).toMatchObject({ title: 'c', note: 'b', rev: 5 });
  });

  it('insert 之后马上撤销：两项抵消，不发送，本机行也去掉', async () => {
    const { cache, outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const r = await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { undone: true } });
    expect(r).toBeNull();
    expect(await outbox.list()).toEqual([]);
    expect(await cache.getRow('todos', uid(1))).toBeUndefined();
    expect(collection('todos').get(uid(1))).toBeUndefined();
  });

  it('拒收：只读行（K7 标的 ro）、不存在的行、重复 insert、校验不过', async () => {
    const { cache, outbox } = await setup();
    const ro: CachedRow = { id: uid(9), server: { id: uid(9), rev: 1 }, view: { id: uid(9), rev: 1 }, ro: true };
    await cache.putRows('todos', [ro]);
    await expect(outbox.enqueue({ table: 'todos', id: uid(9), op: 'patch', data: { title: 'x' } })).rejects.toMatchObject({ code: 'readonly_row' });
    await expect(outbox.enqueue({ table: 'todos', id: uid(8), op: 'patch', data: { title: 'x' } })).rejects.toMatchObject({ code: 'row_missing' });
    await seed(cache, 'todos', uid(3), todo(3));
    await expect(outbox.enqueue({ table: 'todos', id: uid(3), op: 'insert', data: todo(3) })).rejects.toMatchObject({ code: 'row_exists' });
    await expect(outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: { ...todo(1), title: '' } })).rejects.toBeInstanceOf(
      OutboxRejectError,
    );
    expect(await outbox.list()).toEqual([]);
  });
});

describe('发送、确认、失败', () => {
  it('TC-B1-27：离线记 10 条（含 1 条带提醒），带提醒的那条排在最前面先发，10 条都能发完', async () => {
    const { outbox } = await setup();
    for (let n = 1; n <= 10; n++) {
      await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n), remind: n === 7 });
    }
    expect(outbox.getStatus().remindRecs).toEqual(new Set([`todos:${uid(7)}`]));
    const sentIds: string[] = [];
    for (;;) {
      const it = await outbox.next();
      if (!it) break;
      sentIds.push(it.id);
      await outbox.ack(it.op_id, { status: 'ok', rev: 1, prev_rev: null });
    }
    expect(sentIds).toHaveLength(10);
    expect(sentIds[0]).toBe(uid(7));
    expect(sentIds.slice(1)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10].map(uid));
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 0 });
    expect(outbox.getStatus().remindRecs.size).toBe(0);
  });

  it('一次只发一项：已有 inflight 时 next() 返回 null', async () => {
    const { outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    expect(await outbox.next()).not.toBeNull();
    expect(await outbox.next()).toBeNull();
  });

  it('insert 确认：server 副本成形；后面 patch 的 base_rev 补上', async () => {
    const { cache, outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const ins = await outbox.next();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改' } });
    expect((await outbox.list())[1]?.base_rev).toBeNull();
    await outbox.ack(ins?.op_id ?? '', { status: 'ok', rev: 1, prev_rev: null });
    const [p] = await outbox.list();
    expect(p).toMatchObject({ base_rev: 1, op: 'patch' });
    const r = await cache.getRow('todos', uid(1));
    expect(r?.server).toMatchObject({ rev: 1, title: '待办1' });
    expect(r?.view).toMatchObject({ rev: 1, title: '改' });
  });

  it('S1：连续修改不被当成冲突；中间夹了别的设备的写入时 own_revs 记下本机的 rev，新入队的 patch 也带上', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '1' } });
    const a = await outbox.next();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '2' } });
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 6, prev_rev: 5 });
    expect((await outbox.list())[0]).toMatchObject({ base_rev: 6, own_revs: [] });
    expect((await cache.getRow('todos', uid(1)))?.server?.['rev']).toBe(6);

    const b = await outbox.next();
    await outbox.ack(b?.op_id ?? '', { status: 'ok', rev: 9, prev_rev: 8 });   // 7、8 是别的设备写的
    const r = await cache.getRow('todos', uid(1));
    expect(r?.server?.['rev']).toBe(6);
    expect(r?.own_revs).toEqual([9]);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { note: '3' } });
    expect((await outbox.list())[0]).toMatchObject({ base_rev: 6, own_revs: [9] });

    // 服务器的新行到了：server 换新，own_revs 里不大于新 rev 的去掉，view 仍叠着没发的 patch
    await outbox.applyServer('todos', [{ row: { ...todo(1), id: uid(1), title: '2', rev: 9 } }]);
    const r2 = await cache.getRow('todos', uid(1));
    expect(r2?.own_revs).toBeUndefined();
    expect(r2?.view).toMatchObject({ title: '2', note: '3', rev: 9 });
  });

  it('TC-B1-42：收到 426 → 不回滚、不计 tries、不进“发送失败”区，整个队列暂停，以响应体的 min 为准', async () => {
    const { cache, outbox } = await setup();
    for (let n = 1; n <= 3; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    const events: unknown[] = [];
    outbox.onEvent((e) => events.push(e));
    const first = await outbox.next();
    const kind = await outbox.fail(first?.op_id ?? '', { status: 426, code: 'upgrade_required', min: '4.1.0' });
    expect(kind).toBe('upgrade');
    const list = await outbox.list();
    expect(list.map((i) => [i.state, i.tries])).toEqual([
      ['pending', 0],
      ['pending', 0],
      ['pending', 0],
    ]);
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('待办1');   // 没回滚
    expect(outbox.getStatus()).toMatchObject({ pending: 3, failed: 0, paused: { reason: 'upgrade', min: '4.1.0', app: '4.0.0' } });
    expect(events).toEqual([{ type: 'upgrade_required', min: '4.1.0' }]);
    expect(await outbox.next()).toBeNull();   // 暂停中不发

    // 同一版本重启：仍然暂停
    const again = createOutbox(cache, { appVersion: '4.0.0', now: () => clock.t });
    expect((await again.boot()).paused?.min).toBe('4.1.0');
    expect(await again.next()).toBeNull();
    // 新版启动：先跑队列迁移，暂停自动解除，照常发
    const newer = createOutbox(cache, { appVersion: '4.1.0', now: () => clock.t });
    expect((await newer.boot()).paused).toBeNull();
    expect((await newer.next())?.id).toBe(uid(1));
  });

  it('永久失败：回滚 view、进“发送失败”区、发 error 事件；重试后重新叠上', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '坏的' } });
    const errs: unknown[] = [];
    outbox.onEvent((e) => errs.push(e));
    const it1 = await outbox.next();
    expect(await outbox.fail(it1?.op_id ?? '', { status: 400, code: '23514' })).toBe('permanent');
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('待办1');
    expect(collection('todos').get(uid(1))?.['title' as never]).toBe('待办1');
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 1 });
    expect(errs).toMatchObject([{ type: 'error', code: '23514' }]);
    expect(await outbox.next()).toBeNull();

    await outbox.retryFailed();
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('坏的');
    expect(outbox.getStatus()).toMatchObject({ pending: 1, failed: 0 });
  });

  it('vault_required：丢掉这一项、回滚、发 rejected 事件（调用方整表重拉）', async () => {
    const { cache, outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const ev: unknown[] = [];
    outbox.onEvent((e) => ev.push(e));
    const it1 = await outbox.next();
    expect(await outbox.fail(it1?.op_id ?? '', { status: 400, code: 'vault_required' })).toBe('drop');
    expect(await outbox.list()).toEqual([]);
    expect(await cache.getRow('todos', uid(1))).toBeUndefined();
    expect(ev).toMatchObject([{ type: 'rejected', code: 'vault_required' }]);
  });

  it('断网：计 tries、退避；切到前台 clearBackoff 后马上能发；401 不计 tries', async () => {
    const { outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    let it1 = await outbox.next();
    expect(await outbox.fail(it1?.op_id ?? '', { network: true })).toBe('transient');
    expect((await outbox.list())[0]).toMatchObject({ tries: 1, next_at: clock.t + 2000, state: 'pending' });
    expect(await outbox.next()).toBeNull();
    await outbox.clearBackoff();
    it1 = await outbox.next();
    expect(it1).not.toBeNull();
    expect(await outbox.fail(it1?.op_id ?? '', { status: 401 })).toBe('auth');
    expect((await outbox.list())[0]).toMatchObject({ tries: 1, state: 'pending' });
  });

  it('dropServer：服务器已硬删的行，本机行和队列项一起去掉', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1));
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
    await outbox.dropServer('todos', [uid(1)]);
    expect(await cache.getRow('todos', uid(1))).toBeUndefined();
    expect(await outbox.list()).toEqual([]);
  });

  it('applyServer：比本机旧的 rev 忽略；K7 的 ro 标记写进去', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.applyServer('todos', [{ row: { id: uid(1), title: '旧', rev: 4 } }]);
    expect((await cache.getRow('todos', uid(1)))?.server?.['rev']).toBe(5);
    await outbox.applyServer('todos', [{ row: { id: uid(1), title: '新', rev: 6 }, ro: true }]);
    const r = await cache.getRow('todos', uid(1));
    expect(r).toMatchObject({ ro: true, server: { rev: 6 }, view: { title: '新' } });
  });
});
