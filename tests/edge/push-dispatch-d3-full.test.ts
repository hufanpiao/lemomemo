// D3 第 6 点三条按用例表原数补齐（TC-B2-81～83；B2 剩余清单 11-06 第一节 BE-2“结果要落进 QA 报告”）。
// push-dispatch-budget.test.ts 已有 ① 的 300 条 × 3 秒主判据；push-dispatch-round-d3.test.ts 是缩小版。本文件补：
//   ① 同一场景下发送并发峰值 ≤ SEND_CONCURRENCY（10）、单轮发送 ≤ SEND_LIMIT_PER_ROUND（200）、发完剩余那一轮 budget_hit 为假；
//   ② 50 条、替身拖 3 秒、第一轮没返回时再起一轮：每条只发一次，后起的一轮认领不到已被认领的，两轮心跳 sent 合计 50；
//   ③ 认领后、发出前抛错：心跳 claimed 比 sent 多 1，日志不带标题和端点，下一轮不再推，前端 missed() 里有它（“错过的提醒”）。
// 一个用例约 20 秒，不起子进程、不用重型库，按 tests/arch/coverage.test.ts 的规则留在 node 分组，各自带超时。
// 结果打印成一行 `[D3] …`，B2 后端开发自测文档引用这几行。
import { afterEach, describe, expect, it } from 'vitest';
import { handle, SEND_CONCURRENCY, SEND_LIMIT_PER_ROUND } from '../../supabase/functions/push-dispatch/core.ts';
import type { FetchLike } from '../../supabase/functions/_shared/push/send.ts';
import { createFakePush, newPushSubscriber, type FakePushService, type PushSubscriber } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { LOGIC, MemDb, todoRow, uuid } from './push-dispatch-mem.ts';
import { allReminders, missed, remindAtLocal } from '../../src/features/reminders/data/reminder-model.ts';
import { DETAIL_FIELDS_BY_NAME } from '../../supabase/functions/usage-report/core.ts';
import type { Tz } from '../../shared/core/tz.ts';

type Body = { claimed: number; sent: number; failed: number; budget_hit: boolean; left: number };
let fake: FakePushService | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function setup(nUsers: number, delayMs: number) {
  const v = await fakeVapid();
  const db = new MemDb();
  const subs: PushSubscriber[] = [];
  const eps: string[] = [];
  const users = Array.from({ length: nUsers }, (_, i) => `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-0000000000d3`);
  for (const u of users) {
    db.user(u);
    const ep = `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
    eps.push(ep);
    const s = await newPushSubscriber(ep);
    db.device(u, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
    subs.push(s);
  }
  fake = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub }, delayMs });
  const f = fake;
  // 量并发：包一层 fetch，记同时在途的最大数和每轮发了几次
  let live = 0;
  let peak = 0;
  let calls = 0;
  const fetch: FetchLike = async (...a) => {
    live++;
    calls++;
    peak = Math.max(peak, live);
    try {
      return await f.fetch(...a);
    } finally {
      live--;
    }
  };
  const meter = { take: () => { const r = { peak, calls }; peak = 0; calls = 0; return r; } };
  const ids = () => f.requests.filter((r) => r.payload !== null).map((r) => (JSON.parse(r.payload as string) as { id: string }).id);
  return { v, db, users, eps, fetch, meter, ids, f };
}

/** 包一层 store，记这一轮认领成功、失败的条目 id（MemDb.claim 本身不改） */
function tracked(db: MemDb) {
  const won: string[] = [];
  const lost: string[] = [];
  const store = new Proxy(db, {
    get(t, k, r) {
      if (k === 'claim') {
        return async (table: Parameters<MemDb['claim']>[0], id: string, user: string, due: number) => {
          const ok = await t.claim(table, id, user, due);
          (ok ? won : lost).push(id);
          return ok;
        };
      }
      const val = Reflect.get(t, k, r) as unknown;
      return typeof val === 'function' ? (val as (...x: unknown[]) => unknown).bind(t) : val;
    },
  });
  return { store, won, lost };
}

describe('D3 第 6 点（原数补齐）', () => {
  it('① 300 条 × 3 秒：并发峰值 ≤ 10、单轮发送 ≤ 200，剩下的下一轮发完且那一轮 budget_hit 为假', async () => {
    const s = await setup(15, 3000);
    const now0 = Date.now();
    for (let i = 0; i < 300; i++) s.db.put('todos', todoRow(s.users[i % 15] as string, { remind_at: now0 - 30_000 + i }));
    const t0 = Date.now();
    const r1 = (await (await handle(cronReq(), depsFor(s.db, s.v.keys, { fetch: s.fetch }))).json()) as Body;
    const took = Date.now() - t0;
    const m1 = s.meter.take();
    const got1 = s.ids().length;   // 第一轮替身实际收到（解出负载）的条数
    expect(took).toBeLessThan(25_000);
    expect(r1.budget_hit).toBe(true);
    expect(m1.peak).toBeLessThanOrEqual(SEND_CONCURRENCY);
    expect(m1.calls).toBeLessThanOrEqual(SEND_LIMIT_PER_ROUND);
    expect(r1.left).toBe(300 - r1.claimed);
    expect(r1.sent).toBe(got1);
    expect(m1.calls).toBe(got1);
    const beat1 = s.db.beats.at(-1);
    expect(beat1).toMatchObject({ claimed: r1.claimed, sent: r1.sent, failed: 0, budget_hit: true, left: r1.left });
    // usage-report 按心跳名放行 left（lemo-ops 那边看得到剩余条数）
    expect(DETAIL_FIELDS_BY_NAME['push-dispatch']?.num).toContain('left');

    s.f.setDelay(0);
    const later: Body[] = [];
    let total = r1.claimed;
    for (let i = 0; i < 10 && total < 300; i++) {
      const r = (await (await handle(cronReq(), depsFor(s.db, s.v.keys, { fetch: s.fetch }))).json()) as Body;
      expect(s.meter.take().calls).toBeLessThanOrEqual(SEND_LIMIT_PER_ROUND);
      later.push(r);
      total += r.claimed;
    }
    expect(total).toBe(300);
    expect(later.at(-1)?.budget_hit).toBe(false);
    expect(later.at(-1)?.left).toBe(0);
    expect(s.db.beats.at(-1)).not.toHaveProperty('left');   // 没到预算的那一轮心跳不写 left
    const ids = s.ids();
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
    console.log(`[D3①] 第一轮 ${took} ms，claimed=${r1.claimed} sent=${r1.sent} left=${r1.left} budget_hit=${r1.budget_hit}（心跳 left 一致），替身收到 ${got1}，并发峰值 ${m1.peak}，发送 ${m1.calls} 次；之后 ${later.length} 轮发完：${later.map((r) => `${r.claimed}/${String(r.budget_hit)}`).join('、')}；300 条各发 1 次`);
  }, 90_000);

  it('② 50 条 × 3 秒，两轮重叠：每条只发一次，后起的一轮认领不到已被认领的，两轮 sent 合计 50', async () => {
    const s = await setup(3, 3000);   // 3 人：20 + 20 + 10，不超过每人每分钟 20 条
    const now0 = Date.now();
    for (let i = 0; i < 50; i++) s.db.put('todos', todoRow(s.users[i % 3] as string, { remind_at: now0 - 30_000 + i }));
    const a = tracked(s.db);
    const b = tracked(s.db);
    const t0 = Date.now();
    const pa = handle(cronReq(), depsFor(s.db, s.v.keys, { fetch: s.fetch, store: a.store }));
    await new Promise((ok) => setTimeout(ok, 500));   // 第一轮已在发（替身拖 3 秒），再起第二轮
    const pb = handle(cronReq(), depsFor(s.db, s.v.keys, { fetch: s.fetch, store: b.store }));
    const [ra, rb] = (await Promise.all([pa.then((r) => r.json()), pb.then((r) => r.json())])) as [Body, Body];
    const took = Date.now() - t0;
    expect(ra.sent + rb.sent).toBe(50);
    expect(ra.claimed + rb.claimed).toBe(50);
    expect(a.won.filter((id) => b.won.includes(id))).toEqual([]);
    expect(b.lost.every((id) => a.won.includes(id))).toBe(true);
    expect(a.lost.every((id) => b.won.includes(id))).toBe(true);
    expect(a.lost.length + b.lost.length).toBeGreaterThan(0);   // 竞争真的发生了：至少有一次认领撞上了另一轮
    const ids = s.ids();
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    const beats = s.db.beats.slice(-2);
    expect(beats.reduce((n, x) => n + x.sent, 0)).toBe(50);
    console.log(`[D3②] 两轮共 ${took} ms；第一轮 claimed=${ra.claimed} sent=${ra.sent}，第二轮 claimed=${rb.claimed} sent=${rb.sent}，第一轮认领落空 ${a.lost.length} 次、第二轮 ${b.lost.length} 次（都是对方已认领的），两轮认领交集 0；替身收到 50 条、去重 50`);
  }, 60_000);

  it('③ 认领后、发出前抛错：claimed 比 sent 多 1，日志不带标题和端点，下一轮不再推，“错过的提醒”里有它', async () => {
    const s = await setup(1, 0);
    const tz = 'Asia/Seoul' as Tz;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const seoul = new Date(now - 60_000 + 9 * 3_600_000).toISOString();   // 首尔没有夏令时
    const fields = { title: 'BOOM-机密标题', due: seoul.slice(0, 10), due_time: seoul.slice(11, 16), remind_before_min: 0 };
    const remindAt = remindAtLocal('todo', { id: 'x', ...fields, remind_at: null }, now, tz);
    expect(remindAt).toBe(now - 60_000);
    const user = s.users[0] as string;
    const boom = s.db.put('todos', todoRow(user, { ...fields, remind_at: remindAt }));
    const fine = s.db.put('todos', todoRow(user, { title: 'ok', remind_at: now - 1 }));
    const codes: string[] = [];
    const logic = { ...LOGIC, notify: (i: Parameters<typeof LOGIC.notify>[0]) => { if (i.title === fields.title) throw new Error('注入：认领之后、发送之前'); return LOGIC.notify(i); } };
    const r1 = (await (await handle(cronReq(), { ...depsFor(s.db, s.v.keys, { fetch: s.fetch, now: () => now, logic }), log: (c: string) => codes.push(c) })).json()) as Body;
    expect(r1).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
    const beat = s.db.beats.at(-1);
    expect((beat?.claimed ?? 0) - (beat?.sent ?? 0)).toBe(1);
    const ep = s.eps[0] as string;
    expect(ep).toMatch(/^https:/);
    const logText = JSON.stringify(s.db.logs) + JSON.stringify(codes);
    expect(logText).not.toContain('BOOM');
    expect(logText).not.toContain(ep);
    expect(s.db.logs.find((l) => l.item_id === boom.id)?.code).toBe('build_failed');
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).toContain('build_failed');   // 函数日志里有这一笔原因码

    const r2 = (await (await handle(cronReq(), depsFor(s.db, s.v.keys, { fetch: s.fetch, now: () => now + 30_000 }))).json()) as Body;
    expect(r2.claimed).toBe(0);
    expect(s.ids()).toEqual([fine.id]);

    // A 打开 App：同一行（pushed_for = due_at、notified_for 为空）按前端模型算，进“错过的提醒”
    const row = s.db.tables.todos.get(boom.id);
    expect(row?.pushed_for).toBe(remindAt);
    expect(row?.notified_for).toBeNull();
    const list = allReminders([], [row as never], now + 120_000, tz);
    const miss = missed(list, now + 120_000);
    expect(miss.map((r) => r.id)).toEqual([boom.id]);
    console.log(`[D3③] 第一轮 claimed=${r1.claimed} sent=${r1.sent} failed=${r1.failed}（心跳 claimed−sent=1），logs code=build_failed，函数日志 ${codes.join(',')}，都不含标题和端点；第二轮 claimed=${r2.claimed}；前端 missed() 返回这一条`);
  }, 30_000);
});
