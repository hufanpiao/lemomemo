// push-dispatch：R-316（current_tz 坏了，日程改用自己的 tz）、R-317（完成、删除、撤销也收回旧通知），
// 以及 BE-2 安全审查建议 ①③、代码审查建议 ③④⑥ 的行为。内存库见 push-dispatch-mem.ts。
import { afterEach, describe, expect, it } from 'vitest';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { filterUsable, isHandledAfterPush, type ItemRow, type RoundLogic } from '../../supabase/functions/push-dispatch/round.ts';
import { createFakePush, newPushSubscriber, type FakePushService } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { eventRow, LOGIC, MemDb, todoRow, UA, UB, uuid } from './push-dispatch-mem.ts';

let fake: FakePushService | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function world(db = new MemDb().user(UA).user(UB)) {
  const v = await fakeVapid();
  const subs = [];
  for (const u of [UA, UB]) {
    const ep = `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
    const s = await newPushSubscriber(ep);
    db.device(u, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
    subs.push(s);
  }
  fake = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub } });
  const f = fake;
  let last: string[] = [];
  const round = async (now: number, logic?: RoundLogic) => {
    const deps = depsFor(db, v.keys, { fetch: f.fetch, now: () => now, ...(logic ? { logic } : {}) });
    const r = (await (await handle(cronReq(), deps)).json()) as { claimed: number; sent: number };
    last = deps.codes;
    return r;
  };
  const sent = () => f.requests.filter((r) => r.payload !== null).map((r) => JSON.parse(r.payload as string) as { id: string; type: string; title?: string });
  return { db, round, sent, codes: () => last };
}

const BAD_TZ = 'Mars/Olympus_Mons';

describe('R-316：current_tz 不认识', () => {
  it('有时刻的日程改用日程自己的 tz，照常推，记 tz_invalid（profiles:event_tz）；待办、全天日程这一轮跳过，记 tz_invalid（profiles）', async () => {
    const db = new MemDb().user(UA, { current_tz: BAD_TZ }).user(UB, { current_tz: BAD_TZ });
    const w = await world(db);
    const now = Date.now();
    const ev = db.put('events', eventRow(UA, { time: '09:00', tz: 'Asia/Seoul', remind_at: now - 1000 }));
    db.put('todos', todoRow(UB, { remind_at: now - 1000 }));
    db.put('events', eventRow(UB, { remind_at: now - 2000 }));   // 全天日程：没有自己的 tz
    await w.round(now);
    expect(w.sent().map((p) => p.id)).toEqual([ev.id]);
    const tz = db.logs.filter((l) => l.act === 'tz_invalid').map((l) => `${l.user_id}:${l.code}`).sort();
    expect(tz).toEqual([`${UA}:profiles:event_tz`, `${UB}:profiles`]);
    expect(JSON.stringify(db.logs)).not.toContain(BAD_TZ);
  });

  it('同一个人既有日程又有待办：日程照推，原因码记 profiles（有被跳过的）', async () => {
    const db = new MemDb().user(UA, { current_tz: BAD_TZ });
    const w = await world(db);
    const now = Date.now();
    const ev = db.put('events', eventRow(UA, { time: '09:00', tz: 'Asia/Tokyo', remind_at: now - 1000 }));
    db.put('todos', todoRow(UA, { remind_at: now - 500 }));
    await w.round(now);
    expect(w.sent().map((p) => p.id)).toEqual([ev.id]);
    expect(db.logs.filter((l) => l.act === 'tz_invalid').map((l) => l.code)).toEqual(['profiles']);
  });

  it('tz_invalid 每人每小时最多一条（代码审查建议 ⑥）：一分钟后再跑不再记，一小时后再记', async () => {
    const db = new MemDb().user(UA, { current_tz: BAD_TZ });
    const w = await world(db);
    const now = Date.now();
    db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    await w.round(now);
    await w.round(now + 60_000);
    expect(db.logs.filter((l) => l.act === 'tz_invalid')).toHaveLength(1);
    db.put('todos', todoRow(UA, { remind_at: now + 3_600_000 }));
    await w.round(now + 3_601_000);
    expect(db.logs.filter((l) => l.act === 'tz_invalid')).toHaveLength(2);
  });

  it('查最近记录出错：这一轮不记（宁可少记），记 tz_log_check_failed', async () => {
    const db = new MemDb().user(UA, { current_tz: BAD_TZ });
    const w = await world(db);
    db.failOn.add('tzLoggedSince');
    const now = Date.now();
    db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    await w.round(now);
    expect(db.logs.filter((l) => l.act === 'tz_invalid')).toHaveLength(0);
    expect(w.codes()).toContain('tz_log_check_failed');
  });
});

describe('R-317：resolve 也收回完成、删除、撤销、关掉提醒的', () => {
  it('isHandledAfterPush：待办 done、任一表 deleted_at、undone、三列都空都算处理过；日程没有 done 列不看', () => {
    const at = 1_000_000;
    const t = (o: Partial<ItemRow>) => todoRow(UA, { remind_at: at, pushed_for: at, ...o });
    expect(isHandledAfterPush('todos', t({}))).toBe(false);
    expect(isHandledAfterPush('todos', t({ done: true }))).toBe(true);
    expect(isHandledAfterPush('todos', t({ deleted_at: 5 }))).toBe(true);
    expect(isHandledAfterPush('events', eventRow(UA, { remind_at: at, pushed_for: at, undone: true }))).toBe(true);
    expect(isHandledAfterPush('events', eventRow(UA, { remind_at: at, pushed_for: at, done: true } as Partial<ItemRow>))).toBe(false);
    expect(isHandledAfterPush('todos', t({ remind_at: null }))).toBe(true);
    expect(isHandledAfterPush('todos', t({ pushed_for: null, done: true }))).toBe(false);
  });

  it('推过以后：待办完成、待办删除、日程撤销、提醒关掉——各发一条 resolve，pushed_for 置空；没处理的不发', async () => {
    const w = await world();
    const now = Date.now();
    const at = now - 10 * 60_000;
    const p = (o: Partial<ItemRow>) => ({ remind_at: at, pushed_for: at, ...o });
    const done = w.db.put('todos', todoRow(UA, p({ done: true })));
    const del = w.db.put('todos', todoRow(UA, p({ deleted_at: now - 1000 })));
    const undone = w.db.put('events', eventRow(UA, p({ undone: true })));
    const off = w.db.put('todos', todoRow(UA, p({ remind_at: null })));
    const keep = w.db.put('todos', todoRow(UA, p({})));
    await w.round(now);
    const r = w.sent().filter((x) => x.type === 'resolve').map((x) => x.id).sort();
    expect(r).toEqual([done.id, del.id, undone.id, off.id].sort());
    for (const x of [done, del, undone, off]) expect(x.pushed_for).toBeNull();
    expect(keep.pushed_for).toBe(at);
  });
});

describe('第 0 步', () => {
  it('安全审查建议 ③：profiles 里没有这个人：丢弃、不插回队列，记 recalc_no_profile', async () => {
    const db = new MemDb().user(UA);
    db.profs.delete(UA);
    const w = await world(db);
    db.put('todos', todoRow(UA, { remind_at: 5 }), true);
    await w.round(Date.now());
    expect(db.queue.size).toBe(0);
    expect(w.codes()).toContain('recalc_no_profile');
  });

  it('代码审查建议 ④：读完以后 remind_at 又被改了（乐观条件没对上）：不覆盖，插回队列', async () => {
    const db = new MemDb().user(UA);
    const w = await world(db);
    const row = db.put('todos', todoRow(UA, { remind_at: 5 }), true);
    const rows = db.rows.bind(db);
    db.rows = async (table, ids) => (await rows(table, ids)).map((r) => ({ ...r, remind_at: 4 }));   // 读到的是旧值 4
    await w.round(Date.now());
    expect(row.remind_at).toBe(5);
    expect([...db.queue.values()].map((q) => q.id)).toEqual([row.id]);
  });
});

describe('第 2 步、日志、filterUsable', () => {
  it('安全审查建议 ①：某一条的免打扰计算出错，只跳过这一条（记 dnd_failed），同批别的照发', async () => {
    const w = await world();
    const now = Date.now();
    const bad = w.db.put('todos', todoRow(UA, { remind_at: now - 2000 }));
    const ok = w.db.put('todos', todoRow(UB, { remind_at: now - 1000 }));
    const logic: RoundLogic = { ...LOGIC, dndDeferUntil: (ms, tz, d) => { if (ms === bad.remind_at) throw new Error('x'); return LOGIC.dndDeferUntil(ms, tz, d); } };
    await w.round(now, logic);
    expect(w.sent().map((p) => p.id)).toEqual([ok.id]);
    expect(w.codes()).toContain('dnd_failed');
    expect(bad.pushed_for).toBeNull();
  });

  it('代码审查建议 ⑥：logs 批插失败时拆成 20 条一批重试，好的批照样写进去', async () => {
    const w = await world();
    const now = Date.now();
    for (let i = 0; i < 15; i++) for (const u of [UA, UB]) w.db.put('todos', todoRow(u, { remind_at: now - 1000 - i }));
    const ins = w.db.insertLogs.bind(w.db);
    w.db.insertLogs = async (rows) => {
      if (rows.length > 20) throw new Error('db');
      return ins(rows);
    };
    await w.round(now);
    expect(w.db.logs.filter((l) => l.act === 'push_ok')).toHaveLength(30);
    expect(w.codes()).not.toContain('logs_failed');
  });

  it('代码审查建议 ③：filterUsable 最多 n 个并发查，结果按传入顺序、去重；出错的人跳过', async () => {
    let live = 0;
    let peak = 0;
    const users = Array.from({ length: 10 }, (_, i) => `u${i}`);
    const out = await filterUsable([...users, 'u0'], async (u) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      if (u === 'u3') throw new Error('db');
      return u !== 'u5';
    }, undefined, 3);
    expect(peak).toBe(3);
    expect(out).toEqual(users.filter((u) => u !== 'u3' && u !== 'u5'));
  });
});
