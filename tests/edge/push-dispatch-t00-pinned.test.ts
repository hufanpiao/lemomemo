// R-411 提醒队列重写 T00（方案 docs/10-架构/方案-提醒队列重写.md 5.2）：动手前先用内存替身钉住现状，期望照“现在实际怎样”写。
// P13（Q2 选修，改完把 a 组期望改成“截止时刻响”）、P14 和 P12（Q3 选保留，期望不改）、P2（prio 上线后改成“下一轮就算到”）。
import { afterEach, describe, expect, it } from 'vitest';
import { allDay, at, closeWorld, world } from './push-dispatch-allday-world.ts';
import { eventRow, MemDb, todoRow, UA } from './push-dispatch-mem.ts';

afterEach(closeWorld);

const NEXT = '2026-11-06';
const reminds = (w: Awaited<ReturnType<typeof world>>) => w.sent().filter((p) => p.type === 'remind');

describe('T00a P13：新建待办时提前量已经过了（现状：服务器不按规格回落到截止时刻）', () => {
  it('15:00 建、明天 10:00 截止、提前 1 天：remind_at 写成今天 10:00（已过 5 小时），明天 10:00 也不响', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const t = db.put('todos', todoRow(UA, { due: NEXT, due_time: '10:00', remind_before_min: 1440 }), true);
    await w.round(at('15:00'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('10:00'));
    await w.round(at('10:00', NEXT));
    expect(reminds(w)).toHaveLength(0);
  });

  it('10:30 建（提前量刚过 30 分钟）：当场补推一条，明天 10:00 截止时刻不响', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    db.put('todos', todoRow(UA, { due: NEXT, due_time: '10:00', remind_before_min: 1440 }), true);
    await w.round(at('10:30'));
    expect(reminds(w)).toHaveLength(1);
    await w.round(at('10:00', NEXT));
    expect(reminds(w)).toHaveLength(1);
  });
});

describe('T00b P14：推过以后 60 分钟内勾完成又取消（现状：同一条再响一次，Q3 定保留）', () => {
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

describe('T00c P2：一个人排队多时，新建的条目算得晚（现状：每人每轮 50 条，按表名、id 排，待办排在日程后面）', () => {
  it('700 条全天日程排在前面：新建的待办第 15 轮才算到', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    for (let i = 0; i < 700; i++) db.put('events', eventRow(UA, { date: '2026-12-20', time: null, tz: null, remind_days: 0 }), true);
    const t = db.put('todos', todoRow(UA, { due: '2026-12-21', due_time: '18:00', remind_before_min: 60 }), true);
    for (let r = 1; r <= 14; r++) await w.round(at('08:00') + r * 60_000);
    expect(db.tables.todos.get(t.id)?.remind_at).toBeNull();
    await w.round(at('08:15'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(at('17:00', '2026-12-21'));
  });
});

describe('T00d P12：全天日程推过 → 按“稍后” → 收回 → 当天改晚默认时刻（现状：“稍后”那次被挪到新默认时刻才响）', () => {
  it('09:00 推过，09:02 稍后到 09:12，09:05 默认时刻改 11:00：09:12 不响，11:00 才响', async () => {
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
    db.enqueue('events', a.id);   // 真库由设置触发器 settings_allday_defaults_upd 入队
    await w.round(at('09:06'));
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('11:00'));
    await w.round(at('09:12'));
    expect(reminds(w)).toHaveLength(1);
    await w.round(at('11:00'));
    expect(reminds(w)).toHaveLength(2);
  });
});
