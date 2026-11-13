// R-411 提醒队列重写 T00、T24、T25（方案 docs/10-架构/方案-提醒队列重写.md 5.2、6.3）：内存替身版，真库版在 supabase/tests/store-it/push-dispatch-d3.it.ts。
// 第一阶段照“当时实际怎样”钉住；负责人 11-13 定 Q2 修（T00a 改成截止时刻响，T25 钉住另一半：取消完成不回落）、Q3 保留（T00b、T00d 期望不改）、
// prio 上线后 T00c 改成“下一轮就算到”、Q4 认领超时照旧不发并加记录（T24）。
import { afterEach, describe, expect, it } from 'vitest';
import { allDay, at, closeWorld, world } from './push-dispatch-allday-world.ts';
import { eventRow, MemDb, todoRow, UA } from './push-dispatch-mem.ts';

afterEach(closeWorld);

const NEXT = '2026-11-06';
const reminds = (w: Awaited<ReturnType<typeof world>>) => w.sent().filter((p) => p.type === 'remind');

describe('T00a P13（Q2 已修）：新建待办时提前量已经过了，按规格在截止时刻提醒', () => {
  it('15:00 建、明天 10:00 截止、提前 1 天：remind_at 写成明天 10:00（截止时刻），明天 10:00 响一次', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const t = db.put('todos', todoRow(UA, { due: NEXT, due_time: '10:00', remind_before_min: 1440 }), true);
    await w.round(at('15:00'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('10:00', NEXT));
    expect(reminds(w)).toHaveLength(0);
    await w.round(at('10:00', NEXT));
    expect(reminds(w)).toHaveLength(1);
  });

  it('10:30 建（提前量刚过 30 分钟）：当场不补推，明天 10:00 截止时刻响', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    db.put('todos', todoRow(UA, { due: NEXT, due_time: '10:00', remind_before_min: 1440 }), true);
    await w.round(at('10:30'));
    expect(reminds(w)).toHaveLength(0);
    await w.round(at('10:00', NEXT));
    expect(reminds(w)).toHaveLength(1);
  });

  it('已有的待办把截止时刻改近、提前量已过：同样回落到新的截止时刻（改截止也是 fresh）', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const t = db.put('todos', todoRow(UA, { due: NEXT, due_time: '18:00', remind_before_min: 60 }), true);
    await w.round(at('09:00'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('17:00', NEXT));
    db.edit('todos', t.id, { due: '2026-11-05', due_time: '16:00', remind_before_min: 120 });   // 14:00 提醒，已过
    await w.round(at('15:00'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('16:00'));
  });
});

describe('T25（Q2 的另一半）：不是新建、也没改截止的重算不回落', () => {
  it('09:00 推过，09:10 勾完成、09:20 取消：remind_at 保持 09:00，不会变成 10:00 截止时刻再多响一次', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', due_time: '10:00', remind_before_min: 60 }), true);
    await w.round(at('08:00'));
    await w.round(at('09:00'));
    expect(reminds(w)).toHaveLength(1);
    db.edit('todos', t.id, { done: true });
    await w.round(at('09:11'));
    db.edit('todos', t.id, { done: false });
    await w.round(at('09:21'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('09:00'));
    const n = reminds(w).length;   // 09:21 这一轮按 P14（Q3 保留）会再推一次，见 T00b
    await w.round(at('10:00'));
    expect(reminds(w)).toHaveLength(n);
  });
});

describe('T00b P14：推过以后 60 分钟内勾完成又取消（Q3 定保留：同一条再响一次）', () => {
  it('16:00 推过，16:10 勾完成、16:20 取消：16:21 那一轮再推一次，累计 2 条', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', due_time: '17:00', remind_before_min: 60 }), true);
    await w.round(at('15:00'));
    await w.round(at('16:00'));
    expect(reminds(w)).toHaveLength(1);
    db.edit('todos', t.id, { done: true });
    await w.round(at('16:11'));
    db.edit('todos', t.id, { done: false });
    await w.round(at('16:21'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('16:00'));
    expect(reminds(w)).toHaveLength(2);
  });
});

describe('T00c P2（prio 已上线）：一个人排着大量批量重算时，新建的条目下一轮就算到', () => {
  it('700 条全天日程经设置批量入队（prio 1），新建的待办（prio 0）第一轮就算到；批量的照每人 50 条逐轮消化', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    for (let i = 0; i < 700; i++) db.put('events', eventRow(UA, { date: '2026-12-20', time: null, tz: null, remind_days: 0 }));
    db.clock = () => at('07:59');
    db.enqueueScope('allday', UA);   // 真库由设置触发器 settings_remind → remind_enqueue('allday', …)
    expect([...db.queue.values()].every((q) => q.prio === 1)).toBe(true);
    const t = db.put('todos', todoRow(UA, { due: '2026-12-21', due_time: '18:00', remind_before_min: 60 }), true);
    await w.round(at('08:01'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('17:00', '2026-12-21'));
    expect(db.queue.size).toBe(700 - 49);
  });
});

// 第一阶段钉的现状是“09:12 不响、11:00 才响”（旧设置触发器把这条全天日程不论到没到点都入队）。M1 的批量入队只收没到点或还没算的
// （Q1 A“批量只算还没到点的”，方案 3.3、T09），09:05 时这条的 remind_at 09:00 已过、不再入队，“稍后”那次照常在 09:12 响，11:00 不再响。
// 这是 Q1 的连带结果，不是为 P12 另改的（Q3 定的是不为它多记一列）；交回时单独报给主持人。
describe('T00d P12：全天日程推过 → 按“稍后” → 收回 → 当天改晚默认时刻（M1 起：已过的不再批量重算，“稍后”那次照常响）', () => {
  it('09:00 推过，09:02 稍后到 09:12，09:05 默认时刻改 11:00：这条不入队，09:12 响，11:00 不再响', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.default_time': '09:00' });
    const w = await world(db);
    const a = allDay(db, 0);
    await w.round(at('08:00'));
    await w.round(at('09:00'));
    expect(reminds(w)).toHaveLength(1);
    db.edit('events', a.id, { snooze_at: at('09:12') });
    await w.round(at('09:03'));
    expect(w.sent().filter((p) => p.type === 'resolve').map((p) => p.id)).toEqual([a.id]);
    expect(db.tables.events.get(a.id)?.pushed_for).toBeNull();
    db.sets.set(UA, { 'remind.default_time': '11:00' });
    db.clock = () => at('09:05');
    db.enqueueScope('allday', UA);   // 真库由设置触发器 settings_remind → remind_enqueue('allday', …)
    expect(db.queue.size).toBe(0);
    await w.round(at('09:06'));
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('09:00'));
    await w.round(at('09:12'));
    expect(reminds(w)).toHaveLength(2);
    await w.round(at('11:00'));
    expect(reminds(w)).toHaveLength(2);
  });
});

describe('T24（Q4）：认领请求超时，库里可能已认领——照旧不发，另记 claim_timeout', () => {
  it('claim 超时：不发、不计 claimed；函数日志 claim_failed:timeout，logs 一行 act = claim_timeout；预算用完的轮次心跳照写', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', due_time: '17:00', remind_before_min: 60 }), true);
    await w.round(at('15:00'));
    db.timeoutOn.add('claim');
    await w.round(at('16:00'));
    expect(reminds(w)).toHaveLength(0);
    expect(w.codes()).toContain('claim_failed:timeout');
    expect(db.logs.filter((l) => l.act === 'claim_timeout')).toEqual([
      { user_id: UA, t: at('16:00'), device: null, kind: 'run', act: 'claim_timeout', src: 'push-dispatch', coll: 'todos', item_id: t.id, code: 'claim_timeout' },
    ]);
    expect(db.beats.at(-1)?.claimed).toBe(0);
    db.timeoutOn.clear();
    db.failOn.add('claim');
    await w.round(at('16:01'));
    expect(w.codes()).toContain('claim_failed');
    expect(db.logs.filter((l) => l.act === 'claim_timeout')).toHaveLength(1);   // 普通出错不记 claim_timeout
  });
});
