// B2 后端开发自测（11-06）：push-dispatch 的真 store（store.ts 经 PostgREST、private.remind_due / remind_queue_pop / push_heartbeat_write）
// 打本机真库（CI 的 lemo-ci、本机的 lemo-e2e），按用例表原数跑 D3 第 6 点三条（TC-B2-81～83）和 TC-DEL-remind_queue 的函数一侧。推送服务用进程内替身
// （tests/fakes/push-service.ts，fake.fetch 注入 deps.fetch，不开端口、不联网）；VAPID 现生成、用完即丢。
// 内存库版（tests/edge/push-dispatch-budget.test.ts、push-dispatch-d3-full.test.ts）验的是函数流程；这里补“认领是真库上的条件更新”
// （两轮重叠时 PostgREST 的 update … or(pushed_for.is.null, pushed_for.neq.due) 只让一轮更新到行）和真库心跳、日志、队列。
// 跑法：由 supabase/tests/store-it/run.mjs 起（另一个 deno 进程）。CI：npm run test:db（打 lemo-ci）；本机：npm run e2e:real:up →
//   node supabase/tests/store-it/run.mjs --e2e-sb → npm run e2e:real:down。约 35 秒。
// 库里的 pg_cron 每分钟也调 push-dispatch：lemo-e2e 的函数 CRON_SECRET（假值 fake-cron-secret-for-e2e-only）和库里 vault 的 cron_secret
//   不一致，回 401、不跑一轮（net._http_response 可查）；CI 的 lemo-ci 没给函数设 CRON_SECRET，同样回 401。为了不靠这一点，
//   开跑时记下 push-dispatch 这个 cron 任务原来开没开（写进 supabase/.temp/d3-cron-state-<库端口>.json），再停掉；收尾按记下的原状恢复、删掉这个文件。
//   中途被 kill 时文件留着：下次开跑先按文件里的原状恢复，再重新记、再停。
// 每条结果打印成一行 `[D3-real…]`，B2 后端开发自测文档引用。
import { assert, assertEquals, sql, admin, ours, writeLedger, purgeTraces, healLeftovers, mkUser, pending, releaseLock } from './harness.ts';
import { handle, type Deps, type DispatchStore } from '../../functions/push-dispatch/core.ts';
import { makeStore } from '../../functions/push-dispatch/store.ts';
import { isUsable } from '../../functions/_shared/auth.ts';
import type { FetchLike } from '../../functions/_shared/push/send.ts';
import { createFakePush, newPushSubscriber, type PushSubscriber } from '../../../tests/fakes/push-service.ts';
import { CRON, cronReq, fakeVapid } from '../../../tests/edge/push-dispatch-harness.ts';
import { LOGIC } from '../../../tests/edge/push-dispatch-mem.ts';
import { allReminders, missed, remindAtLocal } from '../../../src/features/reminders/data/reminder-model.ts';
import type { Tz } from '../../../shared/core/tz.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
type Body = { claimed: number; sent: number; failed: number; budget_hit: boolean; left: number };
const v = await fakeVapid();
const baseStore = makeStore(admin as never) as DispatchStore;

function deps(fetch: FetchLike, over: Partial<Deps> = {}): Deps {
  return {
    cronSecret: CRON,
    override: { ok: true, url: null },
    vapid: async () => ({ ok: true, keys: v.keys }),
    store: baseStore,
    isUsable: async (u) => (await isUsable(admin as never, u)).ok,
    now: Date.now,
    log: () => {},
    logic: LOGIC,
    fetch,
    ...over,
  };
}
async function round(d: Deps): Promise<Body> {
  const r = await handle(cronReq(), d);
  assertEquals(r.status, 200, 'push-dispatch 回的状态码');
  return (await r.json()) as Body;
}

/** n 个用户，每人一台 FCM 设备（端点按真格式写，只发给进程内替身） */
async function people(tag: string, n: number, delayMs: number) {
  const users: string[] = [];
  const subs: PushSubscriber[] = [];
  const eps: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await mkUser(`${tag}${i}`);
    const ep = `https://fcm.googleapis.com/fcm/send/d3-${crypto.randomUUID()}`;
    const s = await newPushSubscriber(ep);
    await sql`insert into public.devices (id, user_id, platform, push_endpoint, p256dh, auth) values (${crypto.randomUUID()}, ${u}, 'web', ${ep}, ${s.p256dh}, ${s.auth})`;
    users.push(u); subs.push(s); eps.push(ep);
  }
  const fake = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub }, delayMs });
  let live = 0, peak = 0, calls = 0, lastStart = 0, lastEnd = 0;
  const fetch: FetchLike = async (...a) => {
    live++; calls++; peak = Math.max(peak, live); lastStart = Date.now();
    try { return await fake.fetch(...a); } finally { live--; lastEnd = Date.now(); }
  };
  const take = () => { const r = { peak, calls, lastStart, lastEnd }; peak = 0; calls = 0; return r; };
  const ids = () => fake.requests.filter((r) => r.payload !== null).map((r) => (JSON.parse(r.payload as string) as { id: string }).id);
  return { users, eps, fake, fetch, take, ids };
}

/** 造 n 条到点待办（remind_at 直接写，按 i 轮流分给各人），清掉它们的入队项，免得第 0 步按 due 为空重算掉 remind_at */
async function dueTodos(users: readonly string[], n: number, at: number): Promise<string[]> {
  const rows = Array.from({ length: n }, (_, i) => ({ id: crypto.randomUUID(), user_id: users[i % users.length] as string, title: `d3-${i}`, created_at: 1, updated_at: 1, remind_at: at + i }));
  await sql`insert into public.todos ${sql(rows, 'id', 'user_id', 'title', 'created_at', 'updated_at', 'remind_at')}`;
  const ids = rows.map((r) => r.id);
  await sql`delete from private.remind_queue where id = any(${ids}::uuid[])`;
  return ids;
}
const lastBeat = async () => (await sql<{ detail: Record<string, number | boolean> }[]>`select detail from private.heartbeat where name = 'push-dispatch'`)[0]?.detail;

// 文件名带库端口：同一个检出目录并发打不同的库（如 lemo-e2e 55322 和别的本机库）时各记各的，不会串
const DB_PORT = (() => { try { return new URL(Deno.env.get('IT_DB_URL') ?? '').port || '5432'; } catch { return 'unknown'; } })();
const CRON_STATE = `supabase/.temp/d3-cron-state-${DB_PORT}.json`;
/** push-dispatch 这个 cron 任务现在开没开；没有这个任务为 null */
async function dispatchCron(): Promise<boolean | null> {
  const r = await sql<{ active: boolean }[]>`select active from cron.job where jobname = 'push-dispatch'`;
  return r.length === 0 ? null : (r[0]?.active ?? null);
}
async function setDispatchCron(active: boolean): Promise<void> {
  await sql`select cron.alter_job(jobid, active := ${active}) from cron.job where jobname = 'push-dispatch'`;
}
async function readCronState(): Promise<boolean | null> {
  try {
    const v = (JSON.parse(await Deno.readTextFile(CRON_STATE)) as { active?: unknown }).active;
    return typeof v === 'boolean' ? v : null;
  } catch { return null; }
}

Deno.test({ name: 'd3-real 开跑：清掉上次留下的，记下并停掉 push-dispatch 的 cron 任务', ...opts, async fn() {
  await healLeftovers();
  const left = await readCronState();
  if (left !== null) await setDispatchCron(left);   // 上次被 kill：先按当时记下的原状恢复
  const was = await dispatchCron();
  if (was === null) return;
  await Deno.writeTextFile(CRON_STATE, JSON.stringify({ active: was }));   // 先记再停
  await setDispatchCron(false);
  assertEquals(await dispatchCron(), false, 'cron 任务应已停');
} });

Deno.test({ name: '① 300 条 × 替身拖 3 秒（真库）：一轮 25 秒内返回 200、budget_hit 为真、并发 ≤ 10、单轮 ≤ 200，剩下的之后发完、每条一次', ...opts, async fn() {
  const p = await people('d3a', 15, 3000);
  try {
    // 预热：空跑一轮（库里还没有这次的到点条目），让 PostgREST 连接、函数模块、签名器都热起来，不计入 25 秒
    const warm = await round(deps(p.fetch));
    p.take();
    const ids = await dueTodos(p.users, 300, Date.now() - 30_000);
    let lastClaim = 0;
    const timed: DispatchStore = { ...baseStore, async claim(table, id, user, due) { const ok = await baseStore.claim(table, id, user, due); if (ok) lastClaim = Date.now(); return ok; } };
    const t0 = Date.now();
    const r1 = await round(deps(p.fetch, { store: timed }));
    const t1 = Date.now();
    const took = t1 - t0;
    const m1 = p.take();
    const got1 = p.ids().length;
    const seg = `最后一次认领 ${lastClaim - t0} ms、最后一次发送开始 ${m1.lastStart - t0} ms、最后一次发送结束 ${m1.lastEnd - t0} ms、轮末收尾（心跳、日志、回包）${t1 - m1.lastEnd} ms`;
    assert(took < 25_000, `第一轮 ${took} ms，超过 25 秒（${seg}）`);
    assertEquals(r1.sent, got1, 'r1.sent 应等于替身实际收到的条数');
    assertEquals(m1.calls, got1, '发送次数应等于替身收到的条数');
    assert(r1.budget_hit, 'budget_hit 应为真');
    assert(m1.peak <= 10, `并发峰值 ${m1.peak}`);
    assert(m1.calls <= 200, `单轮发送 ${m1.calls}`);
    assertEquals(r1.left, 300 - r1.claimed, 'left');
    const b1 = await lastBeat();
    assertEquals([b1?.['claimed'], b1?.['sent'], b1?.['failed'], b1?.['budget_hit'], b1?.['left']], [r1.claimed, r1.sent, 0, true, r1.left], '真库心跳（含 left）');
    p.fake.setDelay(0);
    const later: Body[] = [];
    let total = r1.claimed;
    for (let i = 0; i < 10 && total < 300; i++) {
      const r = await round(deps(p.fetch));
      assert(p.take().calls <= 200, '单轮发送超过 200');
      later.push(r); total += r.claimed;
    }
    assertEquals(total, 300, '总认领');
    assertEquals(later.at(-1)?.budget_hit, false, '发完剩余那一轮 budget_hit');
    assert(!('left' in ((await lastBeat()) ?? {})), '没到预算的那一轮心跳不应写 left');
    const got = p.ids();
    assertEquals([got.length, new Set(got).size], [300, 300], '替身收到的条数、去重');
    const pushed = (await sql`select count(*)::int as n from public.todos where id = any(${ids}::uuid[]) and pushed_for = remind_at`)[0]?.['n'];
    assertEquals(pushed, 300, '库里 pushed_for = remind_at 的行数');
    console.log(`[D3-real①] 预热后第一轮 ${took} ms（${seg}；预热那一轮 claimed=${warm.claimed}），claimed=${r1.claimed} sent=${r1.sent} left=${r1.left} budget_hit=true，替身收到 ${got1}，并发峰值 ${m1.peak}，发送 ${m1.calls} 次；真库心跳一致（含 left）；之后 ${later.length} 轮：${later.map((r) => `${r.claimed}/${String(r.budget_hit)}`).join('、')}；300 条各发 1 次，库里 300 行 pushed_for = remind_at`);
  } finally {
    await p.fake.close();
  }
} });

Deno.test({ name: '② 50 条 × 替身拖 3 秒、两轮重叠（真库条件更新）：每条只发一次，后起的一轮认领不到已被认领的，两轮 sent 合计 50', ...opts, async fn() {
  const p = await people('d3b', 3, 3000);
  try {
    await dueTodos(p.users, 50, Date.now() - 30_000);
    const track = () => {
      const won: string[] = [], lost: string[] = [];
      const store: DispatchStore = { ...baseStore, async claim(table, id, user, due) { const ok = await baseStore.claim(table, id, user, due); (ok ? won : lost).push(id); return ok; } };
      return { store, won, lost };
    };
    const a = track(), b = track();
    const t0 = Date.now();
    const pa = round(deps(p.fetch, { store: a.store }));
    await new Promise((ok) => setTimeout(ok, 500));
    const pb = round(deps(p.fetch, { store: b.store }));
    const [ra, rb] = await Promise.all([pa, pb]);
    const took = Date.now() - t0;
    assertEquals(ra.sent + rb.sent, 50, '两轮 sent 合计');
    assertEquals(a.won.filter((id) => b.won.includes(id)), [], '两轮认领交集');
    assert(b.lost.every((id) => a.won.includes(id)), '后起一轮落空的都应是前一轮认领的');
    assert(a.lost.every((id) => b.won.includes(id)), '前一轮落空的都应是后起一轮认领的');
    assert(a.lost.length + b.lost.length > 0, '两轮没有撞上同一条：竞争没发生');
    const got = p.ids();
    assertEquals([got.length, new Set(got).size], [50, 50], '替身收到的条数、去重');
    console.log(`[D3-real②] 两轮共 ${took} ms；第一轮 claimed=${ra.claimed} sent=${ra.sent}，第二轮 claimed=${rb.claimed} sent=${rb.sent}，第一轮认领落空 ${a.lost.length} 次、第二轮 ${b.lost.length} 次（都是对方已认领的），交集 0；替身收到 50、去重 50`);
  } finally {
    await p.fake.close();
  }
} });

Deno.test({ name: '③ 认领后、发出前抛错（真库）：claimed 比 sent 多 1、日志不带标题和端点、下一轮不再推、前端 missed() 里有它', ...opts, async fn() {
  const p = await people('d3c', 1, 0);
  try {
    const u = p.users[0] as string;
    const tz = 'Asia/Seoul' as Tz;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const seoul = new Date(now - 60_000 + 9 * 3_600_000).toISOString();
    const f = { title: 'BOOM-机密标题', due: seoul.slice(0, 10), due_time: seoul.slice(11, 16), remind_before_min: 0 };
    const at = remindAtLocal('todo', { id: 'x', ...f, remind_at: null }, now, tz);
    assertEquals(at, now - 60_000, '前端算的 remind_at');
    const boom = crypto.randomUUID(), fine = crypto.randomUUID();
    await sql`insert into public.todos (id, user_id, title, due, due_time, remind_before_min, created_at, updated_at, remind_at)
      values (${boom}, ${u}, ${f.title}, ${f.due}, ${f.due_time}, 0, 1, 1, ${at}), (${fine}, ${u}, 'ok', null, null, null, 1, 1, ${now - 1})`;
    await sql`delete from private.remind_queue where id = any(${[boom, fine]}::uuid[])`;
    const codes: string[] = [];
    const logic = { ...LOGIC, notify: (i: Parameters<typeof LOGIC.notify>[0]) => { if (i.title === f.title) throw new Error('注入：认领之后、发送之前'); return LOGIC.notify(i); } };
    const r1 = await round(deps(p.fetch, { now: () => now, logic, log: (c) => codes.push(c) }));
    assertEquals([r1.claimed, r1.sent, r1.failed], [2, 1, 1], '第一轮');
    const beat = await lastBeat();
    assertEquals(Number(beat?.['claimed']) - Number(beat?.['sent']), 1, '真库心跳 claimed − sent');
    const logs = await sql`select * from public.logs where user_id = ${u}`;
    const text = JSON.stringify(logs) + JSON.stringify(codes);
    assert(!text.includes('BOOM') && !text.includes(p.eps[0] as string), '日志里出现了标题或端点');
    const code = logs.find((l) => l['item_id'] === boom)?.['code'];
    assertEquals(code, 'build_failed', 'logs 里这一条的原因码');
    assert(codes.length > 0 && codes.includes('build_failed'), `函数日志应有 build_failed，实际 ${JSON.stringify(codes)}`);
    const r2 = await round(deps(p.fetch, { now: () => now + 30_000 }));
    assertEquals(r2.claimed, 0, '第二轮认领');
    assertEquals(p.ids(), [fine], '替身只收到 ok 那一条');
    const { data, error } = await admin.from('todos').select('*').eq('id', boom).single();
    assert(!error && data, '读回 BOOM 行失败');
    assertEquals([data['pushed_for'], data['notified_for']], [at, null], 'pushed_for、notified_for');
    const miss = missed(allReminders([], [data as never], now + 120_000, tz), now + 120_000);
    assertEquals(miss.map((r) => r.id), [boom], '前端 missed()');
    console.log(`[D3-real③] 第一轮 claimed=2 sent=1 failed=1，真库心跳 claimed−sent=1，logs 里这一条 code=${String(code)}，函数日志 ${codes.join(',')}，都不含标题和端点；第二轮 claimed=0；PostgREST 读回的行 pushed_for=remind_at、notified_for=null，前端 missed() 返回它`);
  } finally {
    await p.fake.close();
  }
} });

Deno.test({ name: 'TC-DEL-remind_queue（函数一侧、真库）：冷静期的项不出队、不改 remind_at；删掉 auth 用户（account-purge 的 deleteUser）后下一轮队列清为 0', ...opts, async fn() {
  const p = await people('d3d', 1, 0);
  try {
    const u = p.users[0] as string;
    const far = Date.now() + 3 * 86_400_000;
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    for (const id of ids) await sql`insert into public.todos (id, user_id, title, created_at, updated_at, remind_at) values (${id}, ${u}, 'q', 1, 1, ${far})`;
    await sql`insert into private.remind_queue (table_name, id) select 'todos', x from unnest(${ids}::uuid[]) x on conflict do nothing`;
    await pending(u, 7 * 86_400);   // 冷静期：disabled_reason = deletion
    await round(deps(p.fetch));
    const q1 = await sql`select claim, attempts from private.remind_queue where id = any(${ids}::uuid[])`;
    assertEquals(q1.length, 3, '冷静期的项应还在队列里');
    assert(q1.every((x) => x['claim'] === null && Number(x['attempts']) === 0), '冷静期的项被打了租约');
    const ra = await sql`select count(*)::int as n from public.todos where id = any(${ids}::uuid[]) and remind_at = ${far}`;
    assertEquals(ra[0]?.['n'], 3, 'remind_at 被改了');
    // account-purge 到期那一步：deleteUser，级联删 todos；队列行成孤儿（没有外键）
    const { error } = await admin.auth.admin.deleteUser(u);
    assert(!error, `deleteUser 失败：${error?.message}`);
    const orphan = await sql`select count(*)::int as n from private.remind_queue where id = any(${ids}::uuid[])`;
    assertEquals(orphan[0]?.['n'], 3, '删号后、下一轮前孤儿还在');
    await round(deps(p.fetch));
    const q2 = await sql`select count(*)::int as n from private.remind_queue where id = any(${ids}::uuid[])`;
    assertEquals(q2[0]?.['n'], 0, '下一轮后孤儿应清为 0');
    assertEquals(p.ids(), [], '不应推送');
    console.log('[D3-real-DEL] 冷静期：3 项一轮后仍在队列、claim 为空、attempts 0、remind_at 没变；deleteUser 后孤儿 3 项，下一轮 push-dispatch 后清为 0，没有推送');
  } finally {
    await p.fake.close();
  }
} });

Deno.test({ name: 'd3-real 收尾：删掉这次建的用户、恢复 cron 任务、放锁、关连接', ...opts, async fn() {
  // 先恢复 cron：排在最前、单独一层 try，后面 purgeTraces 抛错也不影响它（反过来它抛错也照样删数据、放锁、关连接）
  try {
    const was = await readCronState();
    if (was !== null) {
      await setDispatchCron(was);
      assertEquals(await dispatchCron(), was, 'cron 任务应恢复成开跑前的状态');
      await Deno.remove(CRON_STATE);
    }
  } finally {
    try {
      await purgeTraces(ours);
      await writeLedger([]);
    } finally {
      await releaseLock();
      await sql.end({ timeout: 5 });
    }
  }
} });
