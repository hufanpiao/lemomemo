// R-411 T23（方案-提醒队列重写 3.7、5.2）：第 0 步每项一个结果——不是 same / gone 的记一行函数日志 recalc:<结果>:<表>:<id 前 8 位>；
// logs 只记 prio 0 那几项的 written、ack、r336、failed（act = recalc）；心跳带 recalc 三个数和积压三个数，积压不算停用账号。
import { describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { handle, type HeartbeatDetail } from '../../supabase/functions/push-dispatch/core.ts';
import type { RoundLogic } from '../../supabase/functions/push-dispatch/round.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { eventRow, LOGIC, MemDb, todoRow, UA, UB } from './push-dispatch-mem.ts';

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-05';
const at = (hm: string, day = DAY) => msAt(day, parseHm(hm), SEOUL);
const id8 = (id: string) => id.slice(0, 8);

describe('T23 第 0 步的重算记录', () => {
  it('written、same、r336（prio 0 和 1 各一）、tz_invalid、owner_mismatch、failed、gone 各一项：函数日志、logs、心跳都对', async () => {
    const now = at('08:00');
    const db = new MemDb().user(UA).user(UB);
    db.clock = () => now;
    db.sets.set(UA, { 'remind.default_time': '10:00' });
    // written（prio 0，新建）
    const w = db.put('todos', todoRow(UA, { due: DAY, remind_days: 0, remind_time: '09:00' }), true);
    // same（prio 0）：remind_at 已经是对的
    const s = db.put('todos', todoRow(UA, { due: DAY, remind_days: 0, remind_time: '09:00', remind_at: at('09:00') }));
    db.enqueue('todos', s.id);
    // r336：全天日程当天提醒、默认时刻从 09:00 改成 10:00，这一天已经推过——prio 0 进 logs，prio 1 不进
    const r0 = db.put('events', eventRow(UA, { date: DAY, time: null, tz: null, remind_days: 0, remind_at: at('09:00'), pushed_for: at('09:00') }));
    const r1 = db.put('events', eventRow(UA, { date: DAY, time: null, tz: null, remind_days: 0, remind_at: at('09:00'), pushed_for: at('09:00') }));
    db.queue.set(`events:${r0.id}`, { table_name: 'events', id: r0.id, user_id: UA, prio: 0 });
    db.queue.set(`events:${r1.id}`, { table_name: 'events', id: r1.id, user_id: UA, prio: 1 });
    // tz_invalid：有时刻的日程自己的 tz 认不出
    const tz = db.put('events', eventRow(UA, { date: DAY, time: '15:00', tz: 'Mars/Base', remind_min: 15 }), true);
    // owner_mismatch：队列项记的是 UB，行是 UA 的
    const om = db.put('todos', todoRow(UA, { due: DAY, remind_days: 0 }));
    db.queue.set(`todos:${om.id}`, { table_name: 'todos', id: om.id, user_id: UB, prio: 0 });
    // failed：算的时候抛错
    const f = db.put('todos', todoRow(UA, { due: DAY, remind_days: 0 }), true);
    // gone：行已经被硬删
    db.queue.set('todos:gone', { table_name: 'todos', id: '99999999-0000-4000-8000-000000000000', user_id: UA, prio: 0 });

    const logic: RoundLogic = {
      ...LOGIC,
      remindAtOf: (kind, row, ...rest) => {
        if (row.id === f.id) throw new Error('坏行');
        return LOGIC.remindAtOf(kind, row, ...rest);
      },
    };
    const { keys } = await fakeVapid();
    const d = depsFor(db, keys, { now: () => now, logic, fetch: async () => new Response(null, { status: 201 }) });
    expect((await handle(cronReq(), d)).status).toBe(200);

    expect(d.codes.filter((c) => c.startsWith('recalc:')).sort()).toEqual([
      `recalc:written:todos:${id8(w.id)}`, `recalc:r336:events:${id8(r0.id)}`, `recalc:r336:events:${id8(r1.id)}`,
      `recalc:tz_invalid:events:${id8(tz.id)}`, `recalc:owner_mismatch:todos:${id8(om.id)}`, `recalc:failed:todos:${id8(f.id)}`,
    ].sort());
    // same、gone 只计数不打（替身的 id 前 8 位都一样，按结果名查）
    expect(d.codes.filter((c) => /^recalc:(same|gone):/.test(c))).toEqual([]);
    expect(db.queue.has(`todos:${s.id}`) || db.queue.has('todos:gone')).toBe(false);   // 两项都按租约删掉了
    const rec = db.logs.filter((l) => l.act === 'recalc').map((l) => [l.code, l.coll, l.item_id, l.user_id, l.device, l.src]);
    expect(rec.sort()).toEqual([
      ['failed', 'todos', f.id, UA, null, 'push-dispatch'], ['r336', 'events', r0.id, UA, null, 'push-dispatch'], ['written', 'todos', w.id, UA, null, 'push-dispatch'],
    ].sort());
    const beat = db.beats.at(-1) as HeartbeatDetail;
    expect([beat.recalc_written, beat.recalc_r336, beat.recalc_failed]).toEqual([1, 2, 1]);
    expect([beat.queue_wait0, beat.queue_wait_batch]).toEqual([0, 0]);   // 都处理完了（全部按租约删掉）
  });

  it('S1 例外写回记 ack（算进 recalc_written）；预算到了放回的记 released、不算写回', async () => {
    const now = at('08:00');
    const db = new MemDb().user(UA);
    db.clock = () => now;
    db.sets.set(UA, { 'remind.default_time': '10:00' });
    const a = db.put('events', eventRow(UA, { date: DAY, time: null, tz: null, remind_days: 0, remind_at: at('09:00'), notified_for: at('10:00') }), true);
    const { keys } = await fakeVapid();
    const d = depsFor(db, keys, { now: () => now, fetch: async () => new Response(null, { status: 201 }) });
    await handle(cronReq(), d);
    expect(d.codes).toContain(`recalc:ack:events:${id8(a.id)}`);
    expect(db.logs.filter((l) => l.act === 'recalc').map((l) => l.code)).toEqual(['ack']);
    expect(db.beats.at(-1)?.recalc_written).toBe(1);

    const db2 = new MemDb().user(UA);
    const t = db2.put('todos', todoRow(UA, { due: DAY, remind_days: 0 }), true);
    let clock = now;
    const pop = db2.popQueue.bind(db2);
    db2.popQueue = async (...a) => {
      const r = await pop(...a);
      if (!a[2]) clock += 25_000;   // 新项按批出队以后时钟跳过 20 秒预算（先做的单项重试出队不跳，否则按批那次根本不出队）
      return r;
    };
    const d2 = depsFor(db2, keys, { now: () => clock, fetch: async () => new Response(null, { status: 201 }) });
    await handle(cronReq(), d2);
    expect(d2.codes).toContain(`recalc:released:todos:${id8(t.id)}`);
    expect(db2.queue.size).toBe(1);
    expect(db2.beats.at(-1)?.recalc_written).toBe(0);
  });

  it('积压三个数：只算可用账号的；prio 0 最老一项按 enqueued_at 算秒数', async () => {
    const db = new MemDb().user(UA).user(UB, {}, false);
    let clock = at('07:00');
    db.clock = () => clock;
    db.put('todos', todoRow(UA, { due: DAY, remind_days: 0 }));
    const a = [...db.tables.todos.keys()][0] as string;
    db.enqueue('todos', a);
    clock = at('07:10');
    for (let i = 0; i < 3; i++) db.put('todos', todoRow(UA, { due: DAY, remind_days: 0, remind_at: at('09:00') }));
    db.enqueueScope('floating', UA);   // 三项 prio 1（a 已在队列，prio 0 不变）
    db.put('todos', todoRow(UB, { due: DAY, remind_days: 0 }), true);   // 停用账号的不算
    clock = at('07:30');
    expect(await db.queueStats()).toEqual({ queue_wait0: 1, queue_wait_batch: 3, queue_oldest_s: 30 * 60 });
  });
});
