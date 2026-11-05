// push-dispatch 第 1 步取数、resolve 候选、第 0 步出队的公平性（B2 BE-2 安全审查必改 1、2，代码审查 M2）：
// 内存库照 private.remind_due / remind_pushed / remind_queue_pop 的 SQL 写（tests/edge/push-dispatch-mem.ts），真库上的同一组场景在 rls/31、rls/30。
import { afterEach, describe, expect, it } from 'vitest';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { createFakePush, newPushSubscriber, type FakePushService } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { MemDb, POP_PER_USER, todoRow, UA, UB, uuid } from './push-dispatch-mem.ts';

let fake: FakePushService | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function world() {
  const v = await fakeVapid();
  const db = new MemDb().user(UA).user(UB);
  const subs = [];
  for (const u of [UA, UB]) {
    const ep = `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
    const s = await newPushSubscriber(ep);
    db.device(u, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
    subs.push(s);
  }
  fake = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub } });
  const f = fake;
  const round = async (now: number) => (await (await handle(cronReq(), depsFor(db, v.keys, { fetch: f.fetch, now: () => now }))).json()) as { claimed: number };
  const ids = () => f.requests.filter((r) => r.payload !== null).map((r) => (JSON.parse(r.payload as string) as { id: string; type: string }));
  return { db, round, ids };
}

describe('第 1 步取数（安全审查必改 1、代码审查 M2）', () => {
  it('一个人造 500 条“remind_at 很早、snooze_at 很远”的条目占不住名额：另一个人到点的照样发出去', async () => {
    const w = await world();
    const now = Date.now();
    for (let i = 0; i < 500; i++) w.db.put('todos', todoRow(UB, { id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, remind_at: 946_684_800_000 + i, snooze_at: 9e15 }));
    const ok = w.db.put('todos', todoRow(UA, { remind_at: now - 1000 }));
    await w.round(now);
    expect(w.ids().map((p) => p.id)).toEqual([ok.id]);
  });

  it('先有 500 多条已推过的行（60 分钟窗口内），再来一条新到点的：这一轮照样发出去', async () => {
    const w = await world();
    const now = Date.now();
    for (let i = 0; i < 520; i++) {
      const at = now - 30 * 60_000 + i;
      w.db.put('todos', todoRow(UB, { remind_at: at, pushed_for: at }));
    }
    const fresh = w.db.put('todos', todoRow(UA, { remind_at: now - 500 }));
    await w.round(now);
    expect(w.ids().filter((p) => p.type === 'remind').map((p) => p.id)).toEqual([fresh.id]);
  });

  it('代码审查 M4：30 个没有推送设备的人共 600 条到点行（都比新提醒早）占不住名额：有设备的人新到点的这一轮发出去', async () => {
    const w = await world();
    const now = Date.now();
    for (let u = 0; u < 30; u++) {
      const uid = `c0000000-0000-4000-8000-${u.toString(16).padStart(12, '0')}`;
      w.db.user(uid);   // 账号可用，但没有设备
      for (let i = 0; i < 20; i++) w.db.put('todos', todoRow(uid, { remind_at: now - 50 * 60_000 + u * 20 + i }));
    }
    const fresh = w.db.put('todos', todoRow(UA, { remind_at: now - 500 }));
    // 取数这一步就只回有设备的人的（照 remind_due 的 SQL）
    const due = await w.db.dueRows(now - 60 * 60_000, now, 20, 500);
    expect(due.map((x) => x.row.id)).toEqual([fresh.id]);
    const r = await w.round(now);
    expect(w.ids().filter((p) => p.type === 'remind').map((p) => p.id)).toEqual([fresh.id]);
    expect(r.claimed).toBe(1);   // 没设备的人不认领（pushed_for 不变），也不占这一轮的名额
  });

  it('一个人 600 条都到点：每轮最多取 perUser（20）条，另一个人的照样发；剩下的后面几轮发完', async () => {
    const w = await world();
    const now = Date.now();
    for (let i = 0; i < 600; i++) w.db.put('todos', todoRow(UB, { remind_at: now - 50 * 60_000 + i }));
    const a = w.db.put('todos', todoRow(UA, { remind_at: now - 1 }));
    const r = await w.round(now);
    expect(r.claimed).toBe(21);
    expect(w.ids().map((p) => p.id)).toContain(a.id);
  });

  it('resolve 候选：一个人 500 多条推过、没处理的行占不住名额，另一个人处理过的照样发 resolve', async () => {
    const w = await world();
    const now = Date.now();
    for (let i = 0; i < 520; i++) {
      const at = now - 30 * 60_000 + i;
      w.db.put('todos', todoRow(UB, { remind_at: at, pushed_for: at }));
    }
    const at = now - 20 * 60_000;
    const done = w.db.put('todos', todoRow(UA, { remind_at: at, pushed_for: at, notified_for: at }));
    await w.round(now);
    expect(w.ids().filter((p) => p.type === 'resolve').map((p) => p.id)).toEqual([done.id]);
  });
});

describe('第 0 步出队按人公平（安全审查必改 2）', () => {
  it('一个人 600 条队列项、id 全从 0000… 开始：每轮最多出 50 条，另一个人的照样出队', async () => {
    const db = new MemDb().user(UA).user(UB);
    for (let i = 0; i < 600; i++) db.put('todos', todoRow(UB, { id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}` }), true);
    const a = db.put('todos', todoRow(UA, { id: 'ffffffff-0000-4000-8000-000000000001' }), true);
    const out = await db.popQueue(500, 180);
    expect(out.filter((q) => q.user_id === UB)).toHaveLength(POP_PER_USER);
    expect(out.map((q) => q.id)).toContain(a.id);
    expect(out[0]?.user_id === UA || out[1]?.user_id === UA).toBe(true);   // 先比编号：每人第 1 条排在最前
    // 租约式出队（迁移 20261104130000）：取走的打上租约、还在队列里；没被租的是余下那些
    expect([...db.queue.values()].filter((q) => !q.claim)).toHaveLength(600 - POP_PER_USER);
  });
});
