// push-dispatch 第 1～8 步里原来没有测试守着的几处（REMIND-steps1to8-split 拆分时变异发现的，只补测试、不改行为）：
// ① 第 1 步 collect 自己的几道保险：取数的 SQL（remind_due、remind_pushed）本来就排好序、每人最多 perUser 条、只回可用账号的，collect 又各做了一遍。
//    内存库照 SQL 写，前面那几道都先挡掉了，所以这里让取数故意回“没排序、不封顶、带不可用账号”的行，钉住 collect 自己的那一遍。
// ② 读资料失败、提醒的 TTL、resolve 日志的 fields、纪念日推过以后写回下一次（logic.annivNext 正式实现等 B5，这里用替身给值）。
// ③ 11-05 代码审查低问题 L1～L3（REMIND-split-low）：collect 的总条数截断、resolve 候选的“已处理”过滤、annivNext 收到的参数、每轮第一条一定发。
import { afterEach, describe, expect, it } from 'vitest';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { createFakePush, newPushSubscriber, type FakePushService } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import type { Deps } from '../../supabase/functions/push-dispatch/core.ts';
import type { ItemRow } from '../../supabase/functions/push-dispatch/round.ts';
import { LOGIC, MemDb, todoRow, UA, UB, uuid } from './push-dispatch-mem.ts';

let fake: FakePushService | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

/** 取数不排序（倒过来）、不封顶；isUsable 只认 UA（内存库里两个人都可用，SQL 那一道挡不住 UB）；devsA：UA 有几台设备 */
async function world(over: Partial<Deps> = {}, devsA = 1) {
  const v = await fakeVapid();
  const db = new MemDb().user(UA).user(UB);
  const subs = [];
  for (const u of [...Array<string>(devsA).fill(UA), UB]) {
    const ep = `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
    const s = await newPushSubscriber(ep);
    db.device(u, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
    subs.push(s);
  }
  const rawDue = db.dueRows.bind(db);
  const rawPushed = db.pushedRows.bind(db);
  db.dueRows = async (lo, hi, _perUser, limit) => (await rawDue(lo, hi, 1000, limit)).reverse();
  db.pushedRows = async (lo, hi, _perUser, limit) => (await rawPushed(lo, hi, 1000, limit)).reverse();
  fake = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub } });
  const f = fake;
  const codes: string[] = [];
  const round = async (now: number) => {
    const d = depsFor(db, v.keys, { fetch: f.fetch, now: () => now, isUsable: async (u) => u === UA, limits: { perUser: 3 }, ...over });
    const body = (await (await handle(cronReq(), d)).json()) as { claimed: number; sent: number; failed: number; budget_hit: boolean; left: number };
    codes.push(...d.codes);
    return body;
  };
  const pushes = () => f.requests.filter((r) => r.payload !== null).map((r) => JSON.parse(r.payload as string) as { id: string; type: string; user_id: string });
  const reqs = () => f.requests.filter((r) => r.payload !== null);
  return { db, round, pushes, codes, reqs };
}

describe('第 1 步 collect 自己的保险（取数回来的行不可信时）', () => {
  it('取数没排序、不封顶：按到点先后排好，每人每轮只发最早的 perUser 条', async () => {
    const w = await world();
    const now = Date.now();
    const rows = [0, 1, 2, 3, 4].map((i) => w.db.put('todos', todoRow(UA, { remind_at: now - 5000 + i })));
    const r = await w.round(now);
    expect(r.claimed).toBe(3);
    expect(w.pushes().filter((p) => p.type === 'remind').map((p) => p.id).sort()).toEqual(rows.slice(0, 3).map((x) => x.id).sort());
  });

  it('账号不可用的人：到点的不推，推过、已处理的也不发 resolve', async () => {
    const w = await world();
    const now = Date.now();
    w.db.put('todos', todoRow(UB, { remind_at: now - 1000 }));
    const at = now - 20 * 60_000;
    w.db.put('todos', todoRow(UB, { remind_at: at, pushed_for: at, notified_for: at }));
    const ok = w.db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    await w.round(now);
    expect(w.pushes().map((p) => p.user_id)).toEqual([UA]);
    expect(w.pushes().map((p) => p.id)).toEqual([ok.id]);
  });

  it('读 profile、设置、设备失败：记 dispatch_read_failed，这一轮一条都不认领、不发', async () => {
    const w = await world();
    const now = Date.now();
    w.db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    w.db.failOn.add('settings');
    const r = await w.round(now);
    expect(w.codes).toContain('dispatch_read_failed');
    expect(r.claimed).toBe(0);
    expect(w.pushes()).toEqual([]);
  });
});

describe('发送一段：TTL、resolve 日志、纪念日下一次', () => {
  it('提醒的 TTL 是“到点 + 60 分钟”还剩的秒数（至少 60 秒）', async () => {
    const w = await world();
    const now = Date.now();
    w.db.put('todos', todoRow(UA, { remind_at: now - 10 * 60_000 }));
    await w.round(now);
    expect(w.reqs().map((r) => r.headers['ttl'])).toEqual([String(50 * 60)]);
  });

  it('resolve 发出去的日志带 fields: [“resolve”]，提醒的不带', async () => {
    const w = await world();
    const now = Date.now();
    const at = now - 20 * 60_000;
    const done = w.db.put('todos', todoRow(UA, { remind_at: at, pushed_for: at, notified_for: at }));
    const due = w.db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    await w.round(now);
    const ok = w.db.logs.filter((l) => l.act === 'push_ok');
    expect(ok.find((l) => l.item_id === done.id)?.fields).toEqual(['resolve']);
    expect(ok.find((l) => l.item_id === due.id)?.fields).toBeUndefined();
  });

  const anniv = (due: number): ItemRow => ({
    id: uuid('a'), user_id: UA, rev: 1, deleted_at: null, undone: false, source: 'page', push_show_title: null,
    remind_at: due, notified_for: null, snooze_at: null, pushed_for: null, defer_until: null, name: '结婚纪念日', next_date: '2026-11-04',
  });
  const NEXT = { remind_at: 1_830_000_000_000, next_date: '2027-11-04', past: false };

  it('纪念日推过以后写回下一次（remind_at、next_date）', async () => {
    const w = await world({ logic: { ...LOGIC, annivNext: () => NEXT } });
    const now = Date.now();
    const row = w.db.put('anniversaries', anniv(now - 1000));
    await w.round(now);
    expect(w.pushes().map((p) => p.id)).toEqual([row.id]);
    expect(w.db.tables.anniversaries.get(row.id)).toMatchObject({ remind_at: NEXT.remind_at, next_date: NEXT.next_date });
  });

  it('纪念日写回时这一行已被改过（乐观条件不成立）：不覆盖，记 anniv_next_stale', async () => {
    const w = await world({ logic: { ...LOGIC, annivNext: () => NEXT } });
    const now = Date.now();
    const row = w.db.put('anniversaries', anniv(now - 1000));
    w.db.writeRemind = async () => false;
    await w.round(now);
    expect(w.codes).toContain('anniv_next_stale');
    expect(w.db.tables.anniversaries.get(row.id)?.remind_at).toBe(now - 1000);
  });

  it('组负载时字段不合格（id 不是 UUID）：已认领、不推，日志原因码是 bad_payload（不是笼统的 build_failed）', async () => {
    const w = await world();
    const now = Date.now();
    const bad = w.db.put('todos', todoRow(UA, { id: 'not-a-uuid', remind_at: now - 1000 }));
    const r = await w.round(now);
    expect(r).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(w.db.logs.find((l) => l.item_id === bad.id)?.code).toBe('bad_payload');
  });
});

describe('名额和预算', () => {
  it('第 2 步就超了预算：一条不认领，到点的全算进 left、budget_hit 为真', async () => {
    const w = await world({ limits: { budgetMs: 0 } });
    const now = Date.now();
    w.db.put('todos', todoRow(UA, { remind_at: now - 2000 }));
    w.db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    expect(await w.round(now)).toMatchObject({ claimed: 0, budget_hit: true, left: 2 });
  });

  it('提醒认领没拿到（别的轮已推）：退还名额，后面那条照样发（每轮只有 1 个名额时）', async () => {
    const w = await world({ limits: { sendLimit: 1, concurrency: 1 } });
    const now = Date.now();
    const taken = w.db.put('todos', todoRow(UA, { remind_at: now - 2000 }));
    const next = w.db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    const raw = w.db.claim.bind(w.db);
    w.db.claim = async (t, id, u, due) => (id === taken.id ? false : raw(t, id, u, due));
    await w.round(now);
    expect(w.pushes().map((p) => p.id)).toEqual([next.id]);
  });

  it('resolve 没放回（别的轮已处理）：退还名额，后面那条 resolve 照样发（每轮只有 1 个名额时）', async () => {
    const w = await world({ limits: { sendLimit: 1, concurrency: 1 } });
    const now = Date.now();
    const a1 = now - 30 * 60_000;
    const a2 = now - 20 * 60_000;
    // 这个 world 的取数倒序回来、resolve 候选不另排序：pushed_for 晚的 taken 先轮到
    const next = w.db.put('todos', todoRow(UA, { remind_at: a1, pushed_for: a1, notified_for: a1 }));
    const taken = w.db.put('todos', todoRow(UA, { remind_at: a2, pushed_for: a2, notified_for: a2 }));
    const raw = w.db.releasePushed.bind(w.db);
    w.db.releasePushed = async (t, id, u, p) => (id === taken.id ? false : raw(t, id, u, p));
    await w.round(now);
    expect(w.pushes().map((p) => p.id)).toEqual([next.id]);
  });
});

describe('审查低问题 L1～L3（REMIND-split-low）', () => {
  it('L1 取数不按 limit 截断时：collect 自己只留到点最早的 due 条', async () => {
    const w = await world({ limits: { perUser: 3, due: 2 } });
    const now = Date.now();
    w.db.dueRows = async (lo, hi) => (await MemDb.prototype.dueRows.call(w.db, lo, hi, 1000, 1000)).reverse();
    const rows = [0, 1, 2].map((i) => w.db.put('todos', todoRow(UA, { remind_at: now - 5000 + i })));
    const r = await w.round(now);
    expect(r.claimed).toBe(2);
    expect(w.pushes().map((p) => p.id).sort()).toEqual(rows.slice(0, 2).map((x) => x.id).sort());
  });

  it('L1 resolve 取数混进“推过、还没处理”的行（notified_for 为空）：collect 滤掉，不发 resolve、pushed_for 不清', async () => {
    const w = await world();
    const now = Date.now();
    const at = now - 20 * 60_000;
    const pending = w.db.put('todos', todoRow(UA, { remind_at: at, pushed_for: at, notified_for: null }));
    const raw = w.db.pushedRows;
    w.db.pushedRows = async (lo, hi, p, l) => [...(await raw(lo, hi, p, l)), { table: 'todos', row: { ...pending } }];
    await w.round(now);
    expect(w.pushes()).toEqual([]);
    expect(w.db.calls).not.toContain('releasePushed');
    expect(w.db.tables.todos.get(pending.id)?.pushed_for).toBe(at);
  });

  it('L2 纪念日推过以后算下一次：annivNext 收到 now = 到点 + 1、tz = current_tz、settings = 这个人的设置', async () => {
    const seen: { tz: string; now: number; settings: unknown }[] = [];
    const w = await world({ logic: { ...LOGIC, annivNext: (_row, o) => (seen.push(o), null) } });
    const now = Date.now();
    w.db.user(UA, { current_tz: 'Asia/Tokyo' });
    w.db.sets.set(UA, { 'remind.default_time': '08:30' });
    const due = now - 1000;
    w.db.put('anniversaries', {
      id: uuid('a'), user_id: UA, rev: 1, deleted_at: null, undone: false, source: 'page', push_show_title: null,
      remind_at: due, notified_for: null, snooze_at: null, pushed_for: null, defer_until: null, name: '结婚纪念日', next_date: '2026-11-04',
    });
    await w.round(now);
    expect(seen).toEqual([{ tz: 'Asia/Tokyo', now: due + 1, settings: { 'remind.default_time': '08:30' } }]);
  });

  it('L3 每轮第一条一定发：sendLimit 是 1、这个人有 2 台设备，这一条照发、两台都收到；后面那条留到下一轮', async () => {
    const w = await world({ limits: { perUser: 3, sendLimit: 1, concurrency: 1 } }, 2);
    const now = Date.now();
    const first = w.db.put('todos', todoRow(UA, { remind_at: now - 2000 }));
    w.db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    const r = await w.round(now);
    expect(r).toMatchObject({ claimed: 1, sent: 1, budget_hit: true, left: 1 });
    expect(w.pushes().map((p) => p.id)).toEqual([first.id, first.id]);
    expect(new Set(w.reqs().map((x) => x.subscriber?.endpoint)).size).toBe(2);
  });
});
