// 确认时 server 副本照服务器触发器清系统列（REMIND-shown-persist 修订 1 第 3 节 ③；core/outbox-send.ts 的 ackImpl → shared/logic/server-reset.ts）：
// 三处合并（insert、中间没人写过、中间夹了别的设备）都走 mergeWithServerResets；规则本身的向量在 tests/shared/server-reset.test.ts，这里只钉接线
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllCollections } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

const ev = { title: '全天', date: '2026-11-05', time: null, tz: null, remind_days: 0, remind_at: 1000, pushed_for: 1000, notified_for: null, snooze_at: null, defer_until: 900 };

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('ackImpl 清系统列', () => {
  it('日程挪了日期（换了“哪一次”），中间没人写过：pushed_for、defer_until 清空，rev 推进', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(1), ev, 5);
    await outbox.enqueue({ table: 'events', id: uid(1), op: 'patch', data: { date: '2026-11-06' } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 6, prev_rev: 5 });
    const r = await cache.getRow('events', uid(1));
    expect(r?.server).toMatchObject({ date: '2026-11-06', pushed_for: null, defer_until: null, rev: 6 });
    expect(r?.view).toMatchObject({ pushed_for: null });
  });

  it('中间夹了别的设备的写入：同样清，rev 保持旧值', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(2), ev, 5);
    await outbox.enqueue({ table: 'events', id: uid(2), op: 'patch', data: { remind_days: 1 } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 9, prev_rev: 8 });
    expect((await cache.getRow('events', uid(2)))?.server).toMatchObject({ remind_days: 1, pushed_for: null, defer_until: null, rev: 5 });
  });

  it('只改标题（不是提醒列）：系统列不动', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(3), ev, 5);
    await outbox.enqueue({ table: 'events', id: uid(3), op: 'patch', data: { title: '改名' } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 6, prev_rev: 5 });
    expect((await cache.getRow('events', uid(3)))?.server).toMatchObject({ title: '改名', pushed_for: 1000, defer_until: 900 });
  });

  it('待办清空截止日：连带清 due_time、remind_before_min', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(4), todo(4, { due: '2026-11-08', due_time: '09:00', remind_before_min: 30, pushed_for: 77 }), 5);
    await outbox.enqueue({ table: 'todos', id: uid(4), op: 'patch', data: { due: null } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 6, prev_rev: 5 });
    expect((await cache.getRow('todos', uid(4)))?.server).toMatchObject({ due: null, due_time: null, remind_before_min: null, pushed_for: null });
  });

  it('forked：只按实际落库的列判断（title 另存成副本，不算改了提醒列）', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(5), todo(5, { pushed_for: 77 }), 5);
    await outbox.enqueue({ table: 'todos', id: uid(5), op: 'patch', data: { title: '新标题' } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'forked', rev: 6, prev_rev: 5 });
    expect((await cache.getRow('todos', uid(5)))?.server).toMatchObject({ title: '待办5', pushed_for: 77, rev: 6 });
  });

  it('forked 同时改了提醒列（L7）：按落库的列判断，date 那边照样清 pushed_for；夹了别人写入时也一样', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(7), ev, 5);
    await outbox.enqueue({ table: 'events', id: uid(7), op: 'patch', data: { title: '冲突', date: '2026-11-07' } });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'forked', rev: 6, prev_rev: 5 });
    expect((await cache.getRow('events', uid(7)))?.server).toMatchObject({ title: '全天', date: '2026-11-07', pushed_for: null, rev: 6 });
    await seed(cache, 'events', uid(8), ev, 5);
    await outbox.enqueue({ table: 'events', id: uid(8), op: 'patch', data: { title: '冲突', remind_days: 1 } });
    const b = await outbox.next();
    await outbox.ack(b?.op_id ?? '', { status: 'forked', rev: 9, prev_rev: 8 });
    expect((await cache.getRow('events', uid(8)))?.server).toMatchObject({ title: '全天', remind_days: 1, pushed_for: null, rev: 5 });
  });

  it('新建：不清（真库 INSERT 时触发器不动这几列），id、rev 照旧', async () => {
    const { cache, outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(6), op: 'insert', data: todo(6, { due: '2026-11-08', due_time: '09:00' }) });
    const a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 1, prev_rev: null });
    expect((await cache.getRow('todos', uid(6)))?.server).toMatchObject({ id: uid(6), due_time: '09:00', rev: 1 });
  });
});
