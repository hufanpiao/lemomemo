// push-dispatch 的纪念日（B5 S13；架构 5.4、5.3 第 0 步和第 6 步；TC-B5-22、23）：annivNext 从桩换成 shared/logic/anniv/next-date.ts 的 annivNextOf。
// 这里经真接线（LOGIC = makeLogic(shared 的函数)）测：第 0 步按每条设置 ?? anniv.default_* 重算 remind_at、next_date；
// 第 6 步推过以后写回下一次；行不合格记 failed；韩国阴历（D1）两列写 null。流程本身（乐观条件、日志）在 push-dispatch-guard.test.ts。
import { describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { annivRow, LOGIC, MemDb, UA } from './push-dispatch-mem.ts';

const SEOUL = 'Asia/Seoul';
const at = (day: string, hm = '09:00') => msAt(day, parseHm(hm), SEOUL);

async function run(db: MemDb, now: number) {
  const { keys } = await fakeVapid();
  const d = depsFor(db, keys, { now: () => now, logic: LOGIC, fetch: async () => new Response(null, { status: 201 }) });
  expect((await handle(cronReq(), d)).status).toBe(200);
  return d;
}

describe('第 0 步：纪念日按每条设置重算（R-94）', () => {
  it('没单独设：按设置 anniv.default_offsets / default_time；写 remind_at 和 next_date', async () => {
    const db = new MemDb().user(UA, { current_tz: SEOUL });
    db.sets.set(UA, { 'anniv.default_offsets': [3], 'anniv.default_time': '20:00' });
    const row = db.put('anniversaries', annivRow(UA, { month: 11, day: 20 }), true);
    await run(db, at('2026-11-13', '10:00'));
    expect(db.tables.anniversaries.get(row.id)).toMatchObject({ next_date: '2026-11-20', remind_at: at('2026-11-17', '20:00') });
  });
  it('单独设了的照自己的；都没设按 {7,1} / 09:00', async () => {
    const db = new MemDb().user(UA, { current_tz: SEOUL });
    const own = db.put('anniversaries', annivRow(UA, { month: 11, day: 20, remind_offsets: [0], remind_time: '07:30' }), true);
    await run(db, at('2026-11-13', '10:00'));
    expect(db.tables.anniversaries.get(own.id)).toMatchObject({ next_date: '2026-11-20', remind_at: at('2026-11-20', '07:30') });
    const db2 = new MemDb().user(UA, { current_tz: SEOUL });
    const def = db2.put('anniversaries', annivRow(UA, { month: 11, day: 20 }), true);
    await run(db2, at('2026-11-13', '10:00'));
    expect(db2.tables.anniversaries.get(def.id)?.remind_at).toBe(at('2026-11-19'));   // 提前 7 天（11-13 09:00）已过，取前一天
  });
  it('行不合格（月日越界）：不写，第 0 步记 failed；韩国阴历（D1）算不出：两列写 null', async () => {
    const db = new MemDb().user(UA, { current_tz: SEOUL });
    const bad = db.put('anniversaries', annivRow(UA, { month: 2, day: 30, remind_at: 5 }), true);
    const kr = db.put('anniversaries', annivRow(UA, { calendar: 'lunar', lunar_variant: 'kr', month: 3, day: 1, remind_at: 7, next_date: '2026-04-01' }), true);
    await run(db, at('2026-11-13', '10:00'));
    expect(db.tables.anniversaries.get(bad.id)?.remind_at).toBe(5);
    expect(db.tables.anniversaries.get(kr.id)).toMatchObject({ remind_at: null, next_date: null });
  });
});

describe('第 6 步：推过以后写回下一次', () => {
  it('提前 7 天那次推完，写前一天那次；前一天推完，写明年的提前 7 天', async () => {
    const db = new MemDb().user(UA, { current_tz: SEOUL });
    db.device(UA, { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'BPx', auth: 'au' });
    const due = at('2026-11-13');
    const row = db.put('anniversaries', annivRow(UA, { month: 11, day: 20, remind_at: due, next_date: '2026-11-20' }));
    await run(db, due + 30_000);
    expect(db.tables.anniversaries.get(row.id)).toMatchObject({ remind_at: at('2026-11-19'), next_date: '2026-11-20' });
    const db2 = new MemDb().user(UA, { current_tz: SEOUL });
    db2.device(UA, { endpoint: 'https://fcm.googleapis.com/fcm/send/y', p256dh: 'BPx', auth: 'au' });
    const due2 = at('2026-11-19');
    const row2 = db2.put('anniversaries', annivRow(UA, { month: 11, day: 20, remind_at: due2, next_date: '2026-11-20' }));
    await run(db2, due2 + 30_000);
    expect(db2.tables.anniversaries.get(row2.id)).toMatchObject({ remind_at: at('2027-11-13'), next_date: '2026-11-20' });
  });
});
