// push-dispatch 全天日程：换了“哪一次提醒”照常推（B2 全天日程二轮审查 N-M1，11-04 主持人定做法 ①）。
// 挪日期、改 remind_days、time 在空和非空之间变时，迁移 20261104100000 的触发器 events_occ_reset 清空 notified_for、pushed_for
// （真库语义在 rls/32 ⑧）；这里用 MemDb.edit 模拟客户端编辑，测第 0 步不再按 R-336 压住、到点照推。另钉住 N-L1（换时区再推一次）。
import { afterEach, describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { allDay, at, closeWorld, DAY, world } from './push-dispatch-allday-world.ts';
import { eventRow, MemDb, UA } from './push-dispatch-mem.ts';

afterEach(closeWorld);

describe('二轮审查 N-M1：挪了日期又换了当天 / 前一天，是另一次提醒，照常推（触发器 events_occ_reset 清了 notified_for、pushed_for）', () => {
  it('P1：11-05 当天 09:00 推过，10:00 挪到 11-06 并改成前一天提醒：11-05 20:00 照推“明天 · 名称”', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0, '体检');
    await w.round(at('09:00'));
    db.edit('events', row.id, { date: '2026-11-06', remind_days: 1 });
    await w.round(at('10:00'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('20:00'));
    await w.round(at('20:00'));
    expect(w.sent().filter((p) => p.type === 'remind').map((p) => p.title)).toEqual(['今天 · 体检', '明天 · 体检']);
  });
  it('P1b：同样的场景，但 09:00 那条按过“知道了”（notified_for）：照推', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = db.put('events', eventRow(UA, { title: '体检', date: DAY, time: null, tz: null, remind_days: 0, remind_at: at('09:00'), notified_for: at('09:00') }));
    db.edit('events', row.id, { date: '2026-11-06', remind_days: 1 });
    expect(db.tables.events.get(row.id)?.notified_for).toBeNull();
    await w.round(at('10:00'));
    await w.round(at('20:00'));
    expect(w.sent().filter((p) => p.type === 'remind').map((p) => p.title)).toEqual(['明天 · 体检']);
  });
  it('P2：11-06 的日程 11-05 20:00 推过“明天”，20:30 挪到 11-05 并改成当天提醒（default_time 21:00）：21:00 照推“今天 · 名称”', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.default_time': '21:00' });
    const w = await world(db);
    const row = db.put('events', eventRow(UA, { title: '交房租', date: '2026-11-06', time: null, tz: null, remind_days: 1, remind_at: null }), true);
    await w.round(at('20:00'));
    db.edit('events', row.id, { date: DAY, remind_days: 0 });
    await w.round(at('20:30'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('21:00'));
    await w.round(at('21:00'));
    expect(w.sent().filter((p) => p.type === 'remind').map((p) => p.title)).toEqual(['明天 · 交房租', '今天 · 交房租']);
  });
  it('整行写回（补丁里带着没变的 notified_for、snooze_at）也按值判断：照样清空，之后按新日期照推（R3-L2、R3-L3）', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const old = db.put('events', eventRow(UA, { title: '复查', date: DAY, time: null, tz: null, remind_days: 0, remind_at: at('09:00'), notified_for: at('09:00'), snooze_at: at('09:10') }));
    const row = db.edit('events', old.id, { ...old, date: '2026-11-06' });
    expect([row.notified_for, row.snooze_at, row.pushed_for]).toEqual([null, null, null]);
    await w.round(at('08:00', '2026-11-06'));
    await w.round(at('09:00', '2026-11-06'));
    expect(w.sent().filter((p) => p.type === 'remind').map((p) => p.title)).toEqual(['今天 · 复查']);
  });
  it('只改名称不算另一次提醒：pushed_for 保留，之后再改 default_time 仍不再推（R-336 那组不受影响）', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0, '旧名');
    await w.round(at('09:00'));
    db.edit('events', row.id, { title: '新名' });
    expect(db.tables.events.get(row.id)?.pushed_for).toBe(at('09:00'));
    db.sets.set(UA, { 'remind.default_time': '10:00' });
    db.queue.set(`events:${row.id}`, { table_name: 'events', id: row.id });
    await w.round(at('09:30'));
    await w.round(at('10:00'));
    expect(w.sent().filter((p) => p.type === 'remind')).toHaveLength(1);
  });
  it('N-L1（已知、可接受，写进架构 5.3）：首尔当天 09:00 推过，同一天换到洛杉矶，洛杉矶当地 09:00 会再推一次', async () => {
    const LA = 'America/Los_Angeles';
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0, '跨洋');
    await w.round(at('09:00'));
    db.user(UA, { current_tz: LA });
    db.queue.set(`events:${row.id}`, { table_name: 'events', id: row.id });   // enqueue_floating（采纳新时区时）
    await w.round(msAt(DAY, parseHm('08:00'), LA));
    await w.round(msAt(DAY, parseHm('09:00'), LA));
    expect(w.sent().filter((p) => p.type === 'remind').map((p) => p.title)).toEqual(['今天 · 跨洋', '今天 · 跨洋']);
  });
});
