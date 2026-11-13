// push-dispatch 的全天日程（11-04 B2 后端：全天日程提醒的服务器一侧）：
// 浮动时刻按 current_tz（架构 4.6）；remind_days 0 = 当天的 remind.default_time（出厂 09:00），1 = 前一天 20:00（shared/logic/remind.ts）；
// 文案按 R-333 不写时刻：提醒落在前一天写“明天 · 名称”，落在当天写“今天 · 名称”（shared/logic/notify-text.ts，allDay = {date, at: due_at}）；
// current_tz 不认识照 R-316 跳过，第 0 步、第 2 步原因码都记 profiles。
// 改 remind.default_time 时把全天日程入队是迁移里的触发器做的（真库语义在 supabase/tests/rls/32_allday_remind_enqueue.test.sql），
// 这里测入队以后第 0 步按新的 default_time 重算、到点照推。
import { afterEach, describe, expect, it } from 'vitest';
import { allDay, at, closeWorld, DAY, EVE, world } from './push-dispatch-allday-world.ts';
import { eventRow, MemDb, UA } from './push-dispatch-mem.ts';

afterEach(closeWorld);

describe('全天日程：第 0 步按 current_tz 重算、到点推送，文案按 R-333', () => {
  it('前一天（remind_days = 1）：前一天 20:00（current_tz）推“明天 · 名称”，不写时刻，按钮是推迟 + 知道了', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 1);
    await w.round(at('20:00', EVE));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('20:00', EVE));
    const p = w.sent();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ type: 'remind', kind: 'event', id: row.id, title: '明天 · 家庭聚会' });
    expect(p[0]?.body).toBeUndefined();
    expect(p[0]?.ack).toBeDefined();
    expect(p[0]?.done).toBeUndefined();
  });

  it('当天（remind_days = 0）：没设 remind.default_time 按 09:00；设了 08:30 就 08:30 推“今天 · 名称”', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0);
    await w.round(at('06:00'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('09:00'));
    expect(w.sent()).toHaveLength(0);

    const db2 = new MemDb().user(UA);
    db2.sets.set(UA, { 'remind.default_time': '08:30' });
    const w2 = await world(db2);
    const row2 = allDay(db2, 0, '体检');
    await w2.round(at('08:30'));
    expect(db2.tables.events.get(row2.id)?.remind_at).toBe(at('08:30'));
    expect(w2.sent().map((p) => p.title)).toEqual(['今天 · 体检']);
  });

  it('不写标题（R-334）：前一天 20:00 推“明天有 1 项日程”，当天推“今天有 1 项日程”，都不写时刻、不带名称', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.show_title': false });
    const w = await world(db);
    allDay(db, 1, '机密聚会');
    await w.round(at('20:00', EVE));
    allDay(db, 0, '机密体检');
    await w.round(at('09:00'));
    const p = w.sent();
    expect(p.map((x) => x.title)).toEqual(['明天有 1 项日程', '今天有 1 项日程']);
    expect(JSON.stringify(p)).not.toContain('机密');
    for (const x of p) expect(x.body).toBeUndefined();
  });

  it('韩文界面：“내일 · 名称”', async () => {
    const db = new MemDb().user(UA, { ui_locale: 'ko-KR' });
    const w = await world(db);
    allDay(db, 1, '가족 모임');
    await w.round(at('20:00', EVE));
    expect(w.sent().map((p) => p.title)).toEqual(['내일 · 가족 모임']);
  });

  it('前一天 20:00 落在免打扰（19:00–08:00）：这一轮写 defer_until = 当天 08:00、不推；当天 08:00 推“今天 · 名称”（不是“明天”）', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.dnd': { start: '19:00', end: '08:00' } });
    const w = await world(db);
    const row = allDay(db, 1);
    await w.round(at('20:00', EVE));
    expect(w.sent()).toHaveLength(0);
    expect(db.tables.events.get(row.id)?.defer_until).toBe(at('08:00'));
    await w.round(at('08:00'));
    const p = w.sent();
    expect(p.map((x) => x.title)).toEqual(['今天 · 家庭聚会']);
    expect(db.tables.events.get(row.id)?.pushed_for).toBe(at('08:00'));
  });

  it('remind.default_time 改了（触发器把全天日程重新入队）：第 0 步按新时刻重算 remind_at，到新时刻照推', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0);
    await w.round(at('05:00'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('09:00'));
    // 用户把默认提醒时刻改成 07:00：迁移 20261104100000 的 settings_allday_defaults 触发器把这条放回队列
    db.sets.set(UA, { 'remind.default_time': '07:00' });
    db.queue.set(`events:${row.id}`, { table_name: 'events', id: row.id });
    await w.round(at('05:30'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('07:00'));
    expect(w.sent()).toHaveLength(0);
    await w.round(at('07:00'));
    expect(w.sent().map((p) => p.title)).toEqual(['今天 · 家庭聚会']);
  });

  it('前一天的提醒（20:00）和 remind.default_time 无关：改了 default_time 重算后仍是 20:00', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.default_time': '07:15' });
    const w = await world(db);
    const row = allDay(db, 1);
    await w.round(at('12:00', EVE));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('20:00', EVE));
  });
});

describe('全天日程：current_tz 不认识（R-316）', () => {
  const BAD = 'Mars/Olympus_Mons';
  it('第 0 步：跳过、不写 remind_at、不插回，记 tz_invalid 原因码 profiles（不是 recalc:failed:events）', async () => {
    const db = new MemDb().user(UA, { current_tz: BAD });
    const w = await world(db);
    const row = allDay(db, 0);
    await w.round(at('06:00'));
    expect(db.tables.events.get(row.id)?.remind_at).toBeNull();
    expect(db.queue.size).toBe(0);
    expect(w.codes().filter((c) => c.startsWith('recalc:failed:'))).toEqual([]);
    expect(db.logs.filter((l) => l.act === 'tz_invalid').map((l) => l.code)).toEqual(['profiles']);
    expect(JSON.stringify(db.logs)).not.toContain(BAD);
  });
  it('第 2 步：已到点的全天日程这一轮不推，记 tz_invalid 原因码 profiles', async () => {
    const db = new MemDb().user(UA, { current_tz: BAD });
    const w = await world(db);
    const now = at('09:00');
    db.put('events', eventRow(UA, { date: DAY, time: null, tz: null, remind_days: 0, remind_at: now - 1000 }));
    await w.round(now);
    expect(w.sent()).toHaveLength(0);
    expect(db.logs.filter((l) => l.act === 'tz_invalid').map((l) => l.code)).toEqual(['profiles']);
  });
});

describe('R-335：全天日程过了提醒时刻，60 分钟以内照推，超过不推（和普通提醒同一个窗口）', () => {
  it('当天 09:30 新建（提醒 09:00）：这一轮推“今天 · 名称”', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0, '临时会');
    await w.round(at('09:30'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('09:00'));
    expect(w.sent().map((p) => p.title)).toEqual(['今天 · 临时会']);
  });
  it('当天 10:30 新建（提醒 09:00，已过 90 分钟）：remind_at 写 09:00，不推，之后也不补推', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0, '临时会');
    await w.round(at('10:30'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('09:00'));
    await w.round(at('10:31'));
    expect(w.sent()).toHaveLength(0);
  });
});

describe('R-336：全天日程“推过没有”按这条日程 + 这一天认', () => {
  const requeue = (db: MemDb, id: string) => db.queue.set(`events:${id}`, { table_name: 'events', id });
  it('07:00 推过以后，default_time 改成 07:20、再改成 21:00，都不再推（remind_at 保持 07:00）；第二天的照常推，日程挪到第二天也照常推', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.default_time': '07:00' });
    const w = await world(db);
    const a = allDay(db, 0, '甲');
    await w.round(at('07:00'));
    expect(w.sent().map((p) => p.title)).toEqual(['今天 · 甲']);
    for (const [hm, nowHm] of [['07:20', '07:30'], ['21:00', '07:31']] as const) {
      db.sets.set(UA, { 'remind.default_time': hm });
      requeue(db, a.id);
      await w.round(at(nowHm));
      expect(db.tables.events.get(a.id)?.remind_at, hm).toBe(at('07:00'));
    }
    await w.round(at('07:21'));
    await w.round(at('21:00'));
    expect(w.sent().filter((p) => p.type === 'remind')).toHaveLength(1);
    expect(w.sent().filter((p) => p.type === 'resolve')).toHaveLength(0);   // 也不发 resolve 收回当天那条

    // 第二天：另一条第二天的全天日程照常 21:00 推；“甲”挪到第二天（改日期，触发器入队）也照常推
    const NEXT = '2026-11-06';
    const b = db.put('events', eventRow(UA, { title: '乙', date: NEXT, time: null, tz: null, remind_days: 0, remind_at: null }), true);
    db.edit('events', a.id, { date: NEXT });   // 挪日期：触发器清 pushed_for、notified_for 并入队
    await w.round(at('06:00', NEXT));
    expect(db.tables.events.get(a.id)?.remind_at).toBe(at('21:00', NEXT));
    await w.round(at('21:00', NEXT));
    const later = w.sent().filter((p) => p.type === 'remind').slice(1);
    expect(later.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(later.map((p) => p.title).sort()).toEqual(['今天 · 乙', '今天 · 甲']);
  });
  it('按过“知道了”（notified_for = remind_at，pushed_for 已被 resolve 清掉）以后改 default_time：同样不再推', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = db.put('events', eventRow(UA, { title: '丙', date: DAY, time: null, tz: null, remind_days: 0, remind_at: at('09:00'), notified_for: at('09:00') }));
    db.sets.set(UA, { 'remind.default_time': '10:00' });
    requeue(db, row.id);
    await w.round(at('09:30'));
    await w.round(at('10:00'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('09:00'));
    expect(w.sent()).toHaveLength(0);
  });
  it('前一天 20:00 推过，再把这条改成当天提醒（remind_days 0）：是另一天，当天照常推', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 1, '丁');
    await w.round(at('20:00', EVE));
    db.edit('events', row.id, { remind_days: 0 });
    await w.round(at('06:00'));
    await w.round(at('09:00'));
    expect(w.sent().filter((p) => p.type === 'remind').map((p) => p.title)).toEqual(['明天 · 丁', '今天 · 丁']);
  });
});

describe('全天日程：端到端补充（审查 L6）', () => {
  it('免打扰把当天提醒推到日程过后（第二天 08:00）：只写名称，不写“今天 / 明天”', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.default_time': '23:30', 'remind.dnd': { start: '23:00', end: '08:00' } });
    const w = await world(db);
    const row = allDay(db, 0, '跨夜');
    await w.round(at('23:30'));
    expect(w.sent()).toHaveLength(0);
    expect(db.tables.events.get(row.id)?.defer_until).toBe(at('08:00', '2026-11-06'));
    await w.round(at('08:00', '2026-11-06'));
    expect(w.sent().map((p) => p.title)).toEqual(['跨夜']);
  });
  it('按了“稍后”（snooze_at = 09:10）：09:10 再推一次，仍写“今天 · 名称”', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0, '复诊');
    await w.round(at('09:00'));
    (db.tables.events.get(row.id) as { snooze_at: number | null }).snooze_at = at('09:10');
    await w.round(at('09:10'));
    expect(w.sent().filter((p) => p.type === 'remind').map((p) => p.title)).toEqual(['今天 · 复诊', '今天 · 复诊']);
  });
  it('前一天提醒（remind_days = 1）在 current_tz 不认识时：第 0 步跳过，原因码 profiles', async () => {
    const db = new MemDb().user(UA, { current_tz: 'Mars/Olympus_Mons' });
    const w = await world(db);
    const row = allDay(db, 1);
    await w.round(at('12:00', EVE));
    expect(db.tables.events.get(row.id)?.remind_at).toBeNull();
    expect(w.codes().filter((c) => c.startsWith('recalc:failed:'))).toEqual([]);
    expect(db.logs.filter((l) => l.act === 'tz_invalid').map((l) => l.code)).toEqual(['profiles']);
  });
});

