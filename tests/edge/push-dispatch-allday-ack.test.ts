// REMIND-shown-persist S1（11-05 主持人定修；方案 docs/03-评审/B2/B2-方案-提醒响过持久化.md 第 7 节）：
// 全天日程 07:00 推过，改了 remind.default_time（07:20）以后 R-336 把 remind_at 压在 07:00；客户端“知道了”写的是本机现算的 07:20，
// notified_for ≠ remind_at、due_at 仍等于 pushed_for，resolve 条件不成立，安卓、Edge 上那条 07:00 的推送收不回来。
// 改法：① 迁移 20261105120000 的触发器 events_allday_ack_enqueue：全天日程的 notified_for 改了、而且不等于 remind_at 时入 remind_queue
//   （真库语义在 supabase/tests/rls/36_allday_ack_enqueue.test.sql）；② 第 0 步 R-336：notified_for 正好等于新算出的 remind_at 时不压住、照写回。
//   写回后 notified_for = remind_at：第 1 步不算到点（不会在 07:20 再推），resolve 条件成立，收回 07:00 那条。
import { afterEach, describe, expect, it } from 'vitest';
import { allDay, at, closeWorld, world } from './push-dispatch-allday-world.ts';
import { MemDb, UA } from './push-dispatch-mem.ts';

afterEach(closeWorld);

const requeue = (db: MemDb, id: string) => db.queue.set(`events:${id}`, { table_name: 'events', id });

/** 07:00 推过“今天 · 甲”，default_time 改成 07:20 后第 0 步把 remind_at 压在 07:00 */
async function pushedThenShifted(db: MemDb) {
  db.sets.set(UA, { 'remind.default_time': '07:00' });
  const w = await world(db);
  const a = allDay(db, 0, '甲');
  await w.round(at('07:00'));
  db.sets.set(UA, { 'remind.default_time': '07:20' });
  requeue(db, a.id);
  await w.round(at('07:05'));
  expect(db.tables.events.get(a.id)?.remind_at).toBe(at('07:00'));
  expect(db.tables.events.get(a.id)?.pushed_for).toBe(at('07:00'));
  return { w, a };
}

describe('S1：改了默认时刻以后按“知道了”，要收回已推的那条', () => {
  it('知道了写的是本机现算的 07:20：这一轮发 resolve 收回 07:00 那条，remind_at 写成 07:20，之后不再推', async () => {
    const db = new MemDb().user(UA);
    const { w, a } = await pushedThenShifted(db);
    db.edit('events', a.id, { notified_for: at('07:20') });
    await w.round(at('07:06'));
    const resolves = w.sent().filter((p) => p.type === 'resolve');
    expect(resolves.map((p) => p.id)).toEqual([a.id]);
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('07:20'));
    expect(db.tables.events.get(a.id)?.pushed_for).toBeNull();
    await w.round(at('07:20'));
    await w.round(at('07:40'));
    expect(w.sent().filter((p) => p.type === 'remind')).toHaveLength(1);
    expect(w.sent().filter((p) => p.type === 'resolve')).toHaveLength(1);
  });

  it('对照：知道了写的是服务器的 07:00（旧客户端、同步到了 remind_at）：照旧直接 resolve，remind_at 不动', async () => {
    const db = new MemDb().user(UA);
    const { w, a } = await pushedThenShifted(db);
    db.edit('events', a.id, { notified_for: at('07:00') });
    await w.round(at('07:06'));
    expect(w.sent().filter((p) => p.type === 'resolve').map((p) => p.id)).toEqual([a.id]);
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('07:00'));
    await w.round(at('07:20'));
    expect(w.sent().filter((p) => p.type === 'remind')).toHaveLength(1);
  });

  it('安全审查 A4：读完行以后另一台设备又把 notified_for 改成 07:10：不按旧的“知道了”写回 07:20，放回队列重算后照旧压住', async () => {
    const db = new MemDb().user(UA);
    const { w, a } = await pushedThenShifted(db);
    db.edit('events', a.id, { notified_for: at('07:20') });
    const wr = db.writeRemind.bind(db);
    let raced = false;
    db.writeRemind = async (table, id, user, patch, prev, prevNotified) => {
      if (!raced && id === a.id) {
        raced = true;
        const r = db.tables.events.get(a.id);
        if (r) r.notified_for = at('07:10');   // 直接改替身里的值：模拟夹在读和写之间的那次改动（触发器入队由下面的 requeue 补）
      }
      return wr(table, id, user, patch, prev, prevNotified);
    };
    await w.round(at('07:06'));
    expect(raced).toBe(true);
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('07:00'));
    requeue(db, a.id);
    await w.round(at('07:07'));
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('07:00'));
    await w.round(at('07:20'));
    await w.round(at('07:40'));
    expect(w.sent().filter((p) => p.type === 'remind')).toHaveLength(1);
  });

  it('notified_for 落在同一天、但不等于新算出的时刻（例如又改了默认时刻）：仍按 R-336 压住，不写回、不在新时刻推', async () => {
    const db = new MemDb().user(UA);
    const { w, a } = await pushedThenShifted(db);
    db.edit('events', a.id, { notified_for: at('07:10') });
    await w.round(at('07:06'));
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('07:00'));
    await w.round(at('07:20'));
    expect(w.sent().filter((p) => p.type === 'remind')).toHaveLength(1);
  });
});
