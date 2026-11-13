// push-dispatch 的纪念日（B5 S13；架构 5.4、5.3 第 0 步和第 6 步；TC-B5-22、23）：annivNext 从桩换成 shared/logic/anniv/next-date.ts 的 annivNextOf。
// 这里经真接线（LOGIC = makeLogic(shared 的函数)）测：第 0 步按每条设置 ?? anniv.default_* 重算 remind_at、next_date；
// 第 6 步推过以后写回下一次；行不合格记 failed；韩国阴历（D1）两列写 null。流程本身（乐观条件、日志）在 push-dispatch-guard.test.ts。
import { describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { isDue, isHandledAfterPush } from '../../supabase/functions/push-dispatch/round.ts';
import { newPushSubscriber } from '../fakes/push-service.ts';
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

describe('推过以后 remind_at 已挪到下一次：稍后、resolve 照这一次算（整块评审第 1 条）', () => {
  /** 一台钥匙真能加密的设备（'BPx' 那种假钥匙推一次就被判 bad_keys 清掉，后面几轮没设备不认领） */
  const realDevice = async (db: MemDb) => {
    const ep = 'https://fcm.googleapis.com/fcm/send/anniv-snooze';
    const s = await newPushSubscriber(ep);
    db.device(UA, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
  };
  it('isDue：推过 D-7、remind_at 已挪到 D-1、snooze_at = D-6：D-6 到点；稍后过了窗口、或稍后那一次推过了，回到 remind_at', () => {
    const d7 = at('2026-11-13'), d6 = at('2026-11-14'), d1 = at('2026-11-19');
    const r = annivRow(UA, { remind_at: d1, pushed_for: d7, snooze_at: d6, next_date: '2026-11-20' });
    expect(isDue('anniversaries', r, d6 + 30_000)).toBe(d6);
    expect(isDue('anniversaries', r, d6 - 120_000)).toBe(null);            // 还没到
    expect(isDue('anniversaries', r, d6 + 2 * 3_600_000)).toBe(null);      // 过了窗口（BEHIND 60 分钟），等 D-1
    expect(isDue('anniversaries', r, d1 + 30_000)).toBe(d1);
    expect(isDue('anniversaries', { ...r, pushed_for: d6 }, d1 + 30_000)).toBe(d1);
    expect(isDue('anniversaries', { ...r, defer_until: d6 + 600_000 }, d6 + 630_000)).toBe(d6 + 600_000);   // 免打扰顺延
    // 待办、日程不变：greatest
    expect(isDue('todos', { ...r, title: 't', done: false } as never, d6 + 30_000)).toBe(null);
    expect(isHandledAfterPush('anniversaries', { ...r, snooze_at: null })).toBe(false);
  });
  it('{7,1}：推完 D-7、“明天再提醒”到 D-6，D-6 照推；推完 D-7 下一轮不 resolve 收回；D-1 照推', async () => {
    const db = new MemDb().user(UA, { current_tz: SEOUL });
    await realDevice(db);
    const d7 = at('2026-11-13');
    const row = db.put('anniversaries', annivRow(UA, { month: 11, day: 20, remind_at: d7, next_date: '2026-11-20' }));
    const get = () => db.tables.anniversaries.get(row.id);
    await run(db, d7 + 30_000);
    expect(get()).toMatchObject({ pushed_for: d7, remind_at: at('2026-11-19') });
    // 下一分钟：remind_at 挪了不算“别处处理过”，不 resolve（releasePushed 会把 pushed_for 清空）
    await run(db, d7 + 90_000);
    expect(get()?.pushed_for).toBe(d7);
    // 用户按“明天再提醒”：snooze_at = D-6 09:00；D-6 到点照推
    const d6 = at('2026-11-14');
    Object.assign(get() as object, { snooze_at: d6 });
    await run(db, d6 + 30_000);
    expect(get()?.pushed_for).toBe(d6);
    await run(db, d6 + 90_000);
    expect(get()?.pushed_for).toBe(d6);
    // D-1 照推
    const d1 = at('2026-11-19');
    await run(db, d1 + 30_000);
    expect(get()?.pushed_for).toBe(d1);
  });
  it('推过以后在别处“知道了”、按了稍后、删了：照样 resolve', async () => {
    const d7 = at('2026-11-13');
    for (const patch of [{ notified_for: d7 }, { snooze_at: d7 + 3_600_000 }, { deleted_at: d7 + 1 }]) {
      const db = new MemDb().user(UA, { current_tz: SEOUL });
      await realDevice(db);
      const row = db.put('anniversaries', annivRow(UA, { month: 11, day: 20, remind_at: d7, next_date: '2026-11-20' }));
      await run(db, d7 + 30_000);
      Object.assign(db.tables.anniversaries.get(row.id) as object, patch);
      await run(db, d7 + 90_000);
      expect(db.tables.anniversaries.get(row.id)?.pushed_for).toBe(null);
    }
  });
});
