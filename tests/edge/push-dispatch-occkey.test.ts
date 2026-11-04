// push-dispatch 推送负载里的 occurrenceKey（REMIND-close-occkey 服务器那一半，11-04）：
// 服务器调 shared/logic/remind-route.ts 的 occurrenceKey（logic.ts 的 makeLogic 接线），和前端横幅、本机通知同一份口径——
// 全天日程（没按稍后）是 event:<id>:allday:<日期>:<remind_days>，有时刻的日程、待办、按了稍后的、纪念日就是 tag（纪念日的 occurrenceKey 等 B5 再定）。
// 这里经替身真跑一轮 handle()，拿推出去的负载和前端 reminder-model 的 reminderOf + occurrenceKey 在同一行上算的比（代码审查 L2：不在测试里抄服务器公式）；
// 纪念日前端还不算（reminderOf 只认日程、待办，等 B5），只比字面值。resolve 按当初推的那一次算（代码审查 M1、L1）。
import { afterEach, describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import * as model from '../../src/features/reminders/data/reminder-model.ts';
import * as sharedRemind from '../../shared/logic/remind.ts';
import * as route from '../../shared/logic/remind-route.ts';
import type { ItemRow } from '../../supabase/functions/push-dispatch/round-types.ts';
import { allDay, at, closeWorld, DAY, EVE, SEOUL, world } from './push-dispatch-allday-world.ts';
import { eventRow, MemDb, todoRow, UA, uuid } from './push-dispatch-mem.ts';

afterEach(closeWorld);

type P = { type: string; id: string; due_at: number; occurrenceKey?: string };
/** 前端在同一行上算的 occurrenceKey（reminder-model 的 reminderOf → occurrenceKey；now 取这一次的 due，首尔，没有免打扰） */
function frontKey(kind: 'event' | 'todo', row: ItemRow, due: number, defaultTime?: string): string | null {
  const r = model.reminderOf(kind, { ...row } as unknown as model.Row, due, SEOUL, null, defaultTime);
  return r ? model.occurrenceKey(r) : null;
}

describe('推送负载的 occurrenceKey 和 shared 算出来的一样', () => {
  it('全天日程（前一天、当天）：event:<id>:allday:<日期>:<remind_days>', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const eve = allDay(db, 1);
    await w.round(at('20:00', EVE));
    const day = allDay(db, 0, '体检');
    await w.round(at('09:00'));
    const p = w.sent() as unknown as P[];
    expect(p.map((x) => x.occurrenceKey)).toEqual([`event:${eve.id}:allday:${DAY}:1`, `event:${day.id}:allday:${DAY}:0`]);
    expect(p[0]?.occurrenceKey).toBe(frontKey('event', db.tables.events.get(eve.id) as ItemRow, at('20:00', EVE)));
    expect(p[1]?.occurrenceKey).toBe(frontKey('event', db.tables.events.get(day.id) as ItemRow, at('09:00')));
  });

  it('有时刻的日程：就是 tag event:<id>:<due_at>', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const due = at('10:00');
    const row = db.put('events', eventRow(UA, { date: DAY, time: '10:00', tz: SEOUL, remind_min: 0, remind_at: due }));
    await w.round(due);
    const p = w.sent() as unknown as P[];
    expect(p.map((x) => x.occurrenceKey)).toEqual([`event:${row.id}:${due}`]);
    expect(p[0]?.occurrenceKey).toBe(frontKey('event', row, due));
  });

  it('待办：就是 tag todo:<id>:<due_at>', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const due = at('17:00');
    const row = db.put('todos', todoRow(UA, { due: DAY, due_time: '17:00', remind_before_min: 0, remind_at: due }));
    await w.round(due);
    const p = w.sent() as unknown as P[];
    expect(p.map((x) => x.occurrenceKey)).toEqual([`todo:${row.id}:${due}`]);
    expect(p[0]?.occurrenceKey).toBe(frontKey('todo', row, due));
  });

  it('纪念日：照 reminderTag，anniv:<id>:<due_at>（纪念日的 occurrenceKey 等 B5 再定）', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const due = at('09:00');
    const row: ItemRow = {
      id: uuid('a'), user_id: UA, deleted_at: null, undone: false, source: 'page', push_show_title: null,
      remind_at: due, notified_for: null, snooze_at: null, pushed_for: null, defer_until: null, name: '结婚纪念日', next_date: DAY,
    };
    db.put('anniversaries', row);
    await w.round(due);
    const p = w.sent() as unknown as P[];
    expect(p.map((x) => x.occurrenceKey)).toEqual([`anniv:${row.id}:${due}`]);
    // 前端 reminderOf 还不算纪念日（等 B5），这里只比字面值（= shared 的 reminderTag）
  });

  it('全天日程按了“稍后”的那一次：照 tag（和前端 snoozed 同一口径）', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const due = at('20:10', EVE);
    const row = db.put('events', eventRow(UA, { date: DAY, time: null, tz: null, remind_days: 1, remind_at: at('20:00', EVE), snooze_at: due }));
    await w.round(due);
    const p = w.sent() as unknown as P[];
    expect(p.map((x) => x.occurrenceKey)).toEqual([`event:${row.id}:${due}`]);
    expect(p[0]?.occurrenceKey).toBe(frontKey('event', row, due));
  });

  it('resolve（推过以后在别处按了“知道了”）：带同一个 occurrenceKey', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 1);
    const due = at('20:00', EVE);
    await w.round(due);
    db.edit('events', row.id, { notified_for: due });
    await w.round(due + 60_000);
    const p = w.sent() as unknown as P[];
    expect(p.map((x) => [x.type, x.occurrenceKey])).toEqual([
      ['remind', `event:${row.id}:allday:${DAY}:1`],
      ['resolve', `event:${row.id}:allday:${DAY}:1`],
    ]);
  });
});

describe('resolve 按当初推的那一次判断“是不是稍后”（代码审查 M1、L1）', () => {
  it('M1：推了稍后那一次（09:10，tag）以后再按稍后（09:20）：resolve 带的是 09:10 那条的 tag，不是全天写法', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0);
    await w.round(at('09:00'));
    db.edit('events', row.id, { snooze_at: at('09:10') });
    await w.round(at('09:10'));
    const snoozedPush = (w.sent() as unknown as P[]).find((x) => x.type === 'remind' && x.due_at === at('09:10'));
    expect(snoozedPush?.occurrenceKey).toBe(`event:${row.id}:${at('09:10')}`);
    expect(snoozedPush?.occurrenceKey).toBe(frontKey('event', db.tables.events.get(row.id) as ItemRow, at('09:10')));
    db.edit('events', row.id, { snooze_at: at('09:20') });
    await w.round(at('09:11'));
    const res = (w.sent() as unknown as P[]).filter((x) => x.type === 'resolve').map((x) => [x.due_at, x.occurrenceKey]);
    // 09:10 那一轮直接推新的一次（不单独收回 09:00 那条）；09:11 这一轮收回 09:10 那条，带 tag（修之前是全天写法，探针 B2）
    expect(res).toEqual([[at('09:10'), `event:${row.id}:${at('09:10')}`]]);
  });

  it('L1：07:00 推过，default_time 改成 21:00（R-336 保留旧 remind_at 07:00），再按稍后 07:15：推送和 resolve 都是 07:15 的 tag', async () => {
    const db = new MemDb().user(UA);
    db.sets.set(UA, { 'remind.default_time': '07:00' });
    const w = await world(db);
    const row = allDay(db, 0);
    await w.round(at('07:00'));
    db.sets.set(UA, { 'remind.default_time': '21:00' });
    db.queue.set(`events:${row.id}`, { table_name: 'events', id: row.id });   // 设置触发器把全天日程入队
    await w.round(at('07:01'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(at('07:00'));     // R-336 压住
    db.edit('events', row.id, { snooze_at: at('07:15') });
    await w.round(at('07:15'));
    const tag = `event:${row.id}:${at('07:15')}`;
    const push = (w.sent() as unknown as P[]).find((x) => x.type === 'remind' && x.due_at === at('07:15'));
    expect(push?.occurrenceKey).toBe(tag);
    // 已知差异（代码审查 L1）：前端本机按新 default_time 算出 21:00，不认为这次是稍后，标识是全天写法——
    // 由“SW 撤回时 tag 和 occurrenceKey 任一对上就撤回”的约定兜住（架构 5.3、payload.ts 文件头），这里写明，不当成一致
    expect(frontKey('event', db.tables.events.get(row.id) as ItemRow, at('07:15'), '21:00')).toBe(`event:${row.id}:allday:${DAY}:0`);
    db.edit('events', row.id, { snooze_at: at('07:30') });
    await w.round(at('07:16'));
    const res = (w.sent() as unknown as P[]).filter((x) => x.type === 'resolve' && x.due_at === at('07:15'));
    expect(res.map((x) => x.occurrenceKey)).toEqual([tag]);
  });
});

describe('换时区以后撤回只能靠比 tag（复审 R2-L1；R-341 / N-L1）', () => {
  // resolve 只看最近 60 分钟推过的（pushed_for > now − 60 分钟），所以挑一个“推送时刻在新时区落在前一天”的近邻时区：
  // 首尔 11-05 09:00 = 00:00 UTC = 亚速尔（UTC−1）11-04 23:00，R-336 判不是同一天，remind_at 按新时区重算成亚速尔 11-05 09:00
  it('首尔 09:00 推过（全天写法），半小时后换到亚速尔（UTC−1）：resolve 带的是 tag，和当初那条的 occurrenceKey 对不上，只有 tag 对得上', async () => {
    const AZ = 'Atlantic/Azores';
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = allDay(db, 0, '跨洋');
    await w.round(at('09:00'));
    const first = (w.sent() as unknown as P[])[0];
    expect(first?.occurrenceKey).toBe(`event:${row.id}:allday:${DAY}:0`);
    db.user(UA, { current_tz: AZ });
    db.queue.set(`events:${row.id}`, { table_name: 'events', id: row.id });   // enqueue_floating（采纳新时区时）
    await w.round(at('09:30'));
    expect(db.tables.events.get(row.id)?.remind_at).toBe(msAt(DAY, parseHm('09:00'), AZ));
    const res = (w.sent() as unknown as P[]).filter((x) => x.type === 'resolve');
    expect(res.map((x) => x.due_at)).toEqual([at('09:00')]);
    const firstTag = `event:${row.id}:${first?.due_at}`;   // SW 按 kind、id、due_at 自己拼的 tag
    expect(res[0]?.occurrenceKey).toBe(firstTag);
    expect(res[0]?.occurrenceKey === first?.occurrenceKey).toBe(false);   // 只比 occurrenceKey 撤不回，所以 SW 要“任一对上就撤回”
  });
});

describe('挪进 shared 以后，前端 reminder-model 转发的是同一份函数（导出名不变）', () => {
  it('occurrenceKey、allDayRemindDay', () => {
    expect(model.occurrenceKey).toBe(route.occurrenceKey);
    expect(model.allDayRemindDay).toBe(sharedRemind.allDayRemindDay);
  });
});
