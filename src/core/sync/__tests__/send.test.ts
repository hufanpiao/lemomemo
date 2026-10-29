// K8 发送循环：TC-B1-24（在途期间连续改同一字段 3 次、30 次不报冲突）、TC-B1-25（own_revs：别的设备改的字段照样冲突）、
// TC-B1-23（冲突事件）、TC-B1-26（gone）、TC-B1-27（离线 10 条恢复后全部发出、带提醒的先发）、TC-B1-42（426 暂停）、
// TC-B1-82（401 刷新重发不计 tries、刷新回被移除、断网时刷新失败）、not_found 丢掉、闸
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllCollections } from '../../store.ts';
import { clock, seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import type { Outbox } from '../../outbox-types.ts';
import { sendAll, type SendDeps } from '../send.ts';
import type { SyncEvent } from '../types.ts';
import { fakeTransport, type FakeTransport } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

function deps(outbox: Outbox, t: FakeTransport, over: Partial<SendDeps> = {}): SendDeps & { events: SyncEvent[]; removedCodes: string[]; touchedTables: string[] } {
  const events: SyncEvent[] = [];
  const removedCodes: string[] = [];
  const touchedTables: string[] = [];
  return {
    outbox,
    transport: t,
    gated: () => outbox.isSuspended(),
    blocked: () => false,
    emit: (e) => events.push(e),
    removed: (c) => removedCodes.push(c),
    touched: (tb) => touchedTables.push(tb),
    events,
    removedCodes,
    touchedTables,
    ...over,
  };
}

async function seedBoth(t: FakeTransport, cache: Parameters<typeof seed>[0], n: number): Promise<string> {
  const id = uid(n);
  const row = t.server.insert('todos', todo(n));
  await seed(cache, 'todos', id, todo(n), row.rev);
  return id;
}

describe('TC-B1-27 离线 10 条，恢复网络后全部同步', () => {
  it('离线时一条也发不出去、不丢；联网后 10 条全部上去，带提醒的那条最先发', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let n = 1; n <= 10; n++) {
      await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n), remind: n === 7 });
    }
    t.offline = true;
    expect(await sendAll(deps(outbox, t))).toBe('retry');
    expect(outbox.getStatus().pending).toBe(10);

    t.offline = false;
    await outbox.clearBackoff();
    expect(await sendAll(deps(outbox, t))).toBe('done');
    expect(outbox.getStatus().pending).toBe(0);
    expect(t.server.table('todos').size).toBe(10);
    expect(t.calls[0]).toBe(`insert:todos:${uid(7)}`);
  });

  it('发送中途断网：这一项退避，tries 加 1，其余留在队列里', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let n = 1; n <= 3; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    t.failNext.push({ network: true });
    expect(await sendAll(deps(outbox, t))).toBe('retry');
    const items = await outbox.list();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ state: 'pending', tries: 1 });
    expect(items[0]?.next_at).toBeGreaterThan(clock.t);
  });
});

describe('TC-B1-24 同一设备在途期间连续改同一字段，不报冲突', () => {
  for (const times of [3, 30]) {
    it(`第一个 patch 在途时连续改同一字段 ${times} 次：全部 ok，不出 conflict、forked`, async () => {
      const { cache, outbox } = await setup();
      const t = fakeTransport();
      const id = await seedBoth(t, cache, 1);
      await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: '改 0' } });
      let n = 0;
      // 每个 patch 在路上（服务器已应用、确认还没回来）时，本机又改一次同一个字段
      t.beforeReply = async () => {
        if (n >= times) return;
        n++;
        await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: `改 ${n}` } });
      };
      const d = deps(outbox, t);
      let out = await sendAll(d);
      while (out === 'more') out = await sendAll(d);   // 一批最多 20 项（K8 复审建议 1），30 次要分两批
      expect(out).toBe('done');
      const results = [...t.server.applied.values()];
      expect(results.length).toBeGreaterThan(1);
      expect(results.every((r) => r.status === 'ok')).toBe(true);
      expect(d.events).toEqual([]);
      expect(t.server.table('todos').get(id)?.['title']).toBe(`改 ${times}`);
      expect((await cache.getRow('todos', id))?.view).toMatchObject({ title: `改 ${times}` });
    });
  }

  it('确认时中间夹了别的设备的写入（rev 记进 own_revs）：本机后面改同一字段仍是 ok', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = await seedBoth(t, cache, 1);
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: 'A' } });
    t.server.edit('todos', id, { note: '别的设备改了备注' });   // 本机还不知道：服务器 rev 2
    let first = true;
    t.beforeReply = async () => {
      if (!first) return;
      first = false;
      await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: 'B' } });
    };
    // 第一次确认 rev 3、prev_rev 2 ≠ base_rev 1：第二项 base_rev 留 1、own_revs 记 [3]；服务器上 title 的 fv 是 3，靠 own_revs 跳过
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect([...t.server.applied.values()].map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(d.events).toEqual([]);
  });
});

describe('TC-B1-25 / TC-B1-23 别的设备改过的字段照样冲突', () => {
  it('第一个 patch 在途，另一台设备改了 note；本机排队中的改 note 和改 important：只有 note 报冲突，发 conflict 事件并补拉这张表', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = await seedBoth(t, cache, 1);
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: '本机' } });
    let first = true;
    t.beforeReply = async () => {
      if (!first) return;
      first = false;
      t.server.edit('todos', id, { note: '另一台' });
      await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { note: '本机备注', important: true } });
    };
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ type: 'conflict', status: 'conflict', table: 'todos', id, conflicts: ['note'], old: { note: '另一台' } });
    expect(d.touchedTables).toEqual(['todos']);
    expect(outbox.getStatus().pending).toBe(0);   // 冲突也算确认：后保存的胜出，不留在队列里
  });
});

describe('gone、not_found、永久失败', () => {
  it('TC-B1-26 一边删一边改：gone → 进“发送失败”区并发 gone 事件（带原修改，界面据此“恢复并保留我的修改”）', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = await seedBoth(t, cache, 1);
    t.server.edit('todos', id, { deleted_at: 123 });
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: '我的修改' } });
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(d.events[0]).toMatchObject({ type: 'gone', table: 'todos', id, data: { title: '我的修改' } });
    const [item] = await outbox.list();
    expect(item).toMatchObject({ state: 'failed', error: 'gone' });

    // “恢复并保留我的修改”：发一个改 deleted_at 的新 patch（不再 gone），丢掉失败的那一项
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { deleted_at: null, undone: false, title: '我的修改' } });
    await outbox.discard(item?.op_id ?? '');
    expect(await sendAll(d)).toBe('done');
    expect(t.server.table('todos').get(id)).toMatchObject({ deleted_at: null, title: '我的修改' });
  });

  it('not_found（服务器上已硬删）：丢掉这一项、不出冲突副本、不重试', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const id = await seedBoth(t, cache, 1);
    t.server.hardDelete('todos', id);
    await outbox.enqueue({ table: 'todos', id, op: 'patch', data: { title: 'x' } });
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(await outbox.list()).toEqual([]);
    expect(d.events).toEqual([]);
  });

  it('永久失败（400）不挡后面的项', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let n = 1; n <= 2; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    t.failNext.push({ status: 400, code: 'check_violation' });
    expect(await sendAll(deps(outbox, t))).toBe('done');
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 1 });
    expect(t.server.table('todos').has(uid(2))).toBe(true);
  });
});

describe('TC-B1-42 收到 426', () => {
  it('不回滚、不计 tries、整个队列暂停；挡同步时不发', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let n = 1; n <= 3; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    t.failNext.push({ status: 426, code: 'upgrade_required', min: '4.1.0' });
    expect(await sendAll(deps(outbox, t))).toBe('paused');
    expect(outbox.getStatus()).toMatchObject({ pending: 3, failed: 0, paused: { min: '4.1.0' } });
    expect((await outbox.list()).every((i) => i.tries === 0)).toBe(true);

    const calls = t.calls.length;
    expect(await sendAll(deps(outbox, t, { blocked: () => true }))).toBe('paused');
    expect(t.calls.length).toBe(calls);
  });
});

describe('TC-B1-82 令牌过期（401）', () => {
  it('② 刷新一次再重发：成功，不计 tries、不进“发送失败”区', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    t.failNext.push({ status: 401, code: 'PGRST301' });
    t.refresh.push('ok');
    expect(await sendAll(deps(outbox, t))).toBe('done');
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 0 });
    expect(t.server.table('todos').size).toBe(1);
  });

  it('③ 刷新回 session_not_found：走被移除', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    t.failNext.push({ status: 401 });
    t.refresh.push('removed');
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('removed');
    expect(d.removedCodes).toEqual(['session_not_found']);
  });

  it('④ 断网时刷新失败：留在 pending、不计 tries，联网后刷新成功再发出', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    t.failNext.push({ status: 401 });
    t.refresh.push('network');
    expect(await sendAll(deps(outbox, t))).toBe('retry');
    expect((await outbox.list())[0]).toMatchObject({ state: 'pending', tries: 0 });
    expect(await sendAll(deps(outbox, t))).toBe('done');
    expect(outbox.getStatus().pending).toBe(0);
  });

  it('刷新成功后马上又 401：不当被移除；这一项按临时故障退避（tries + 1）、停发、记 auth_retry_401（K8 审查必改 4）', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let n = 1; n <= 2; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    t.failNext.push({ status: 401 }, { status: 401 });
    t.refresh.push('ok');
    const logs: string[] = [];
    const d = deps(outbox, t, { log: (c) => logs.push(c) });
    expect(await sendAll(d)).toBe('retry');
    expect(d.removedCodes).toEqual([]);
    expect(outbox.isSuspended()).toBe(false);
    expect(logs).toEqual(['auth_retry_401']);
    const items = await outbox.list();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ state: 'pending', tries: 1 });
    expect(items[0]?.next_at).toBeGreaterThan(clock.t);
    expect(t.calls).toHaveLength(2);   // 停发：第二条没发
  });

  it('发送前看令牌：ensureSession 回被移除就不发', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    t.ensure = 'removed';
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('removed');
    expect(t.calls).toEqual([]);
  });

  it('session_revoked（服务器回被移除）：outbox 设闸，发送停下', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let n = 1; n <= 2; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    t.failNext.push({ status: 400, code: 'session_revoked' });
    expect(await sendAll(deps(outbox, t))).toBe('removed');
    expect(outbox.isSuspended()).toBe(true);
    expect(t.calls).toHaveLength(1);
  });
});

describe('闸', () => {
  it('请求在路上时设了闸（换账号）：不写回、不再发下一项', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    for (let n = 1; n <= 2; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    let switching = false;
    const orig = t.insertRow.bind(t);
    t.insertRow = async (table, data) => {
      const r = await orig(table, data);
      switching = true;
      return r;
    };
    expect(await sendAll(deps(outbox, t, { gated: () => switching }))).toBe('stopped');
    expect(t.calls).toHaveLength(1);
    expect((await outbox.list())[0]?.state).toBe('inflight');   // 没 ack：页面会重新载入，下次启动复位
  });
});
