// B2 后端开发自测（11-06）：push-dispatch 的真 store（store.ts 经 PostgREST、private.remind_due / remind_queue_pop / push_heartbeat_write）
// 打本机真库（CI 的 lemo-ci、本机的 lemo-e2e），按用例表原数跑 D3 第 6 点三条（TC-B2-81～83）和 TC-DEL-remind_queue 的函数一侧，
//   以及 R-411 T00 真库版（文件末尾，11-13）。推送服务用进程内替身
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
import { addDays, msAt, parseHm, type DateStr } from '../../../shared/core/date.ts';

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
    await sql`insert into private.remind_queue (table_name, id, user_id) select 'todos', x, ${u}::uuid from unnest(${ids}::uuid[]) x on conflict do nothing`;
    await pending(u, 7 * 86_400);   // 冷静期：disabled_reason = deletion
    await round(deps(p.fetch));
    const q1 = await sql`select claim, attempts from private.remind_queue where id = any(${ids}::uuid[])`;
    assertEquals(q1.length, 3, '冷静期的项应还在队列里');
    assert(q1.every((x) => x['claim'] === null && Number(x['attempts']) === 0), '冷静期的项被打了租约');
    const ra = await sql`select count(*)::int as n from public.todos where id = any(${ids}::uuid[]) and remind_at = ${far}`;
    assertEquals(ra[0]?.['n'], 3, 'remind_at 被改了');
    // account-purge 到期那一步：deleteUser，级联删 todos；R-411 迁移 20261113100000 起队列行带 user_id 外键，跟着级联删，不再留孤儿等下一轮
    const { error } = await admin.auth.admin.deleteUser(u);
    assert(!error, `deleteUser 失败：${error?.message}`);
    const gone = await sql`select count(*)::int as n from private.remind_queue where id = any(${ids}::uuid[])`;
    assertEquals(gone[0]?.['n'], 0, '删号后队列行应随外键级联删掉');
    await round(deps(p.fetch));
    const q2 = await sql`select count(*)::int as n from private.remind_queue where id = any(${ids}::uuid[])`;
    assertEquals(q2[0]?.['n'], 0, '下一轮后队列仍为 0');
    assertEquals(p.ids(), [], '不应推送');
    console.log('[D3-real-DEL] 冷静期：3 项一轮后仍在队列、claim 为空、attempts 0、remind_at 没变；deleteUser 后队列行随外键级联删光，下一轮 push-dispatch 也没有推送');
  } finally {
    await p.fake.close();
  }
} });

// ===== R-411 T00 真库版（方案 docs/10-架构/方案-提醒队列重写.md 5.2；内存版 tests/edge/push-dispatch-t00-pinned.test.ts） =====
// 第二阶段钉了 M1 之后、push-dispatch 改动之前的行为；第三阶段（11-13）push-dispatch 接上 fresh 以后，P13 按 Q2 改成“截止时刻响”（T00a 两条），
// P14 照 Q3 保留（T00b），P2 下一轮就算到（T00c）。T00a 另核第 0 步的重算记录（T23 真库部分：logs 的 recalc 行、心跳的 recalc 和积压字段）。
// 库里的触发器按真实 now() 判“没到点”，所以日期放在 20 天后（首尔时区，profiles.current_tz 默认 Asia/Seoul），一轮的时刻由 deps.now 注入。
const T00_DAY = addDays(new Date().toISOString().slice(0, 10) as DateStr, 20);
const tAt = (hm: string, day: DateStr = T00_DAY): number => msAt(day, parseHm(hm), 'Asia/Seoul' as Tz);
const at0 = (p: { fetch: FetchLike }, ms: number) => round(deps(p.fetch, { now: () => ms }));
const kinds = (p: { fake: { requests: { payload: unknown }[] } }, type: string) =>
  p.fake.requests.filter((r) => r.payload !== null).map((r) => JSON.parse(r.payload as string) as { type: string; id: string }).filter((x) => x.type === type);
const row = async (table: 'todos' | 'events', id: string) => (await sql`select remind_at, pushed_for from ${sql('public.' + table)} where id = ${id}`)[0];
const q = async (id: string) => (await sql`select prio, fresh, min_ver from private.remind_queue where id = ${id}`)[0];

/** 新建一条明天 10:00 截止、提前 1 天的待办，在 day 这天的 hm 跑第一轮；返回 [人, 待办 id] */
async function p13(tag: string, day: DateStr, hm: string) {
  const p = await people(tag, 1, 0);
  const t = crypto.randomUUID();
  await sql`insert into public.todos (id, user_id, title, created_at, updated_at, due, due_time, remind_before_min) values (${t}, ${p.users[0] as string}, ${tag}, 1, 1, ${addDays(day, 1)}, '10:00', 1440)`;
  assertEquals({ ...(await q(t)) }, { prio: 0, fresh: true, min_ver: 0 }, '新建待办入队：用户改的 prio 0、fresh（6.3 Q2 回落要用）');
  await at0(p, tAt(hm, day));
  return [p, t] as const;
}

Deno.test({ name: 'R-411 T00a P13（真库，Q2 已修）：15:00 建、明天 10:00 截止、提前 1 天：remind_at 回落到明天 10:00，到时响一次；重算记录进 logs 和心跳', ...opts, async fn() {
  const day = T00_DAY;
  const [p, t] = await p13('t00a', day, '15:00');
  try {
    assertEquals(Number((await row('todos', t))?.['remind_at']), tAt('10:00', addDays(day, 1)), 'remind_at 回落到截止时刻（明天 10:00）');
    assertEquals(kinds(p, 'remind').length, 0, '当天不推');
    const rec = await sql`select code, coll, src from public.logs where item_id = ${t} and act = 'recalc'`;
    assertEquals(rec.map((x) => [x['code'], x['coll'], x['src']]), [['written', 'todos', 'push-dispatch']], 'prio 0 的写回记一行 recalc');
    const beat = await lastBeat();
    assertEquals(typeof beat?.['recalc_written'], 'number', '心跳带 recalc_written');
    for (const k of ['queue_wait0', 'queue_wait_batch', 'queue_oldest_s']) assertEquals(typeof beat?.[k], 'number', `心跳带 ${k}（remind_queue_stats）`);
    await at0(p, tAt('10:00', addDays(day, 1)));
    assertEquals(kinds(p, 'remind').length, 1, '明天 10:00 截止时刻响一次');
    console.log('[R411-T00a] 新建待办 fresh：15:00 建的 remind_at 回落到明天 10:00，到时推 1 条；logs 有 recalc/written，心跳有 recalc 和积压字段');
  } finally {
    await p.fake.close();
  }
} });

Deno.test({ name: 'R-411 T00a P13（真库，Q2 已修）：10:30 建（提前量刚过 30 分钟）：当场不补推，明天 10:00 截止时刻响', ...opts, async fn() {
  const day = addDays(T00_DAY, 2);
  const [p] = await p13('t00a2', day, '10:30');
  try {
    assertEquals(kinds(p, 'remind').length, 0, '当场不补推');
    await at0(p, tAt('10:00', addDays(day, 1)));
    assertEquals(kinds(p, 'remind').length, 1, '明天 10:00 截止时刻响');
    console.log('[R411-T00a2] 10:30 建：当场不推，明天截止时刻推 1 条');
  } finally {
    await p.fake.close();
  }
} });

Deno.test({ name: 'R-411 T00b P14（真库、钉现状，Q3 保留）：推过以后勾完成又取消，同一条再推一次', ...opts, async fn() {
  const p = await people('t00b', 1, 0);
  const day = addDays(T00_DAY, 4);
  try {
    const u = p.users[0] as string;
    const t = crypto.randomUUID();
    await sql`insert into public.todos (id, user_id, title, created_at, updated_at, due, due_time, remind_before_min) values (${t}, ${u}, 't00b', 1, 1, ${day}, '17:00', 60)`;
    await at0(p, tAt('15:00', day));
    await at0(p, tAt('16:00', day));
    assertEquals(kinds(p, 'remind').length, 1, '16:00 推一条');
    await sql`update public.todos set done = true where id = ${t}`;
    await at0(p, tAt('16:11', day));
    await sql`update public.todos set done = false where id = ${t}`;
    assertEquals((await q(t))?.['prio'], 0, '取消完成：用户改的、prio 0 入队');
    await at0(p, tAt('16:21', day));
    assertEquals(Number((await row('todos', t))?.['remind_at']), tAt('16:00', day), 'remind_at 仍是 16:00');
    assertEquals(kinds(p, 'remind').length, 2, '16:21 再推一次，累计 2 条（现状，Q3 保留）');
    console.log('[R411-T00b] 16:00 推过、勾完成又取消：16:21 再推一次，累计 2 条');
  } finally {
    await p.fake.close();
  }
} });

Deno.test({ name: 'R-411 T00c P2（真库、M1 已修排队一半）：700 条全天日程经改默认时刻批量入队（prio 1），新建待办（prio 0）第一轮就算到', ...opts, async fn() {
  const p = await people('t00c', 1, 0);
  const day = addDays(T00_DAY, 6);
  try {
    const u = p.users[0] as string;
    const evs = Array.from({ length: 700 }, (_, i) => ({ id: crypto.randomUUID(), user_id: u, title: `t00c-${i}`, created_at: 1, updated_at: 1, date: day, remind_days: 0 }));
    await sql`insert into public.events ${sql(evs, 'id', 'user_id', 'title', 'created_at', 'updated_at', 'date', 'remind_days')}`;
    await sql`delete from private.remind_queue where user_id = ${u}`;   // 只留批量那一路：设置触发器按 scope allday 入队
    await sql`insert into public.settings (id, user_id, key, value) values (gen_random_uuid(), ${u}, 'remind.default_time', '"09:00"'::jsonb)`;
    const pr = await sql`select prio, count(*)::int as n from private.remind_queue where user_id = ${u} group by prio order by prio`;
    assertEquals(pr.map((x) => [x['prio'], x['n']]), [[1, 700]], '改默认时刻：700 条批量入队，remind_at 为空的是 prio 1');
    const t = crypto.randomUUID();
    await sql`insert into public.todos (id, user_id, title, created_at, updated_at, due, due_time, remind_before_min) values (${t}, ${u}, 't00c', 1, 1, ${addDays(day, 1)}, '18:00', 60)`;
    await at0(p, tAt('08:00', day));
    assertEquals(Number((await row('todos', t))?.['remind_at']), tAt('17:00', addDays(day, 1)), '新建的待办第一轮就算到（内存版现状是第 15 轮）');
    const left = (await sql`select count(*)::int as n from private.remind_queue where user_id = ${u}`)[0]?.['n'];
    assertEquals(left, 651, '这一轮每人 50 条：待办 1 条 + 日程 49 条，剩 651 条日程');
    console.log('[R411-T00c] 700 条全天日程批量入队 prio 1；新建待办 prio 0，第一轮就算到；本轮该用户取 50 条，剩 651');
  } finally {
    await p.fake.close();
  }
} });

// Q3 A 保留现状：改默认时刻时这条（日期没过）照样批量入队、挪到新默认时刻。真库的 now() 比模拟的“这一天”早 20 多天，remind_at 离真实现在超过 24 小时，
// 所以是 prio 2；真实时间里当天的那一种（prio 1）由内存版 T00d 钉着（tests/edge/push-dispatch-t00-pinned.test.ts）。
Deno.test({ name: 'R-411 T00d P12（真库，Q3 保留现状）：全天日程推过 → 稍后 → 收回 → 改晚默认时刻：按新默认时刻重算（prio 2），09:12 不响、11:00 响', ...opts, async fn() {
  const p = await people('t00d', 1, 0);
  const day = addDays(T00_DAY, 9);
  try {
    const u = p.users[0] as string;
    await sql`insert into public.settings (id, user_id, key, value) values (gen_random_uuid(), ${u}, 'remind.default_time', '"09:00"'::jsonb)`;
    const a = crypto.randomUUID();
    await sql`insert into public.events (id, user_id, title, created_at, updated_at, date, remind_days) values (${a}, ${u}, 't00d', 1, 1, ${day}, 0)`;
    await at0(p, tAt('08:00', day));
    await at0(p, tAt('09:00', day));
    assertEquals(kinds(p, 'remind').length, 1, '09:00 推一条');
    await sql`update public.events set snooze_at = ${tAt('09:12', day)} where id = ${a}`;
    await at0(p, tAt('09:03', day));
    assertEquals(kinds(p, 'resolve').map((x) => x.id), [a], '按稍后：收回 09:00 那条');
    assertEquals((await row('events', a))?.['pushed_for'], null, '收回后 pushed_for 为空');
    await sql`update public.settings set value = '"11:00"'::jsonb where user_id = ${u} and key = 'remind.default_time'`;
    assertEquals((await q(a))?.['prio'], 2, '改默认时刻：由 remind_on_settings 批量入队（真库，不用手动 enqueue）；remind_at 离真实现在超过 24 小时，是 prio 2');
    await at0(p, tAt('09:06', day));
    assertEquals(Number((await row('events', a))?.['remind_at']), tAt('11:00', day), 'remind_at 挪到 11:00');
    await at0(p, tAt('09:12', day));
    assertEquals(kinds(p, 'remind').length, 1, '09:12（稍后那次）不响：remind_at 已挪到 11:00');
    await at0(p, tAt('11:00', day));
    assertEquals(kinds(p, 'remind').length, 2, '11:00 才响');
    console.log('[R411-T00d] Q3 保留现状：改默认 11:00 后 prio 2 入队、挪到 11:00；09:12 不响，11:00 才响');
  } finally {
    await p.fake.close();
  }
} });

// R-411 后续（独立评审 M1，11-13）：第 0 步只对“这一行本身写不进去”的错误 hold。真 PostgREST 回数据类错误时 error.code 是 SQLSTATE，
// store 的 dbError 认得出、抛 db:data；乐观条件不成立照旧回 false（不抛）
Deno.test({ name: 'R-411 写回数据类错误（真库）：next_date 不是日期 → 真 store 抛 db:data；值合格时照常写回', ...opts, async fn() {
  const u = await mkUser('d3-data');
  const id = crypto.randomUUID();
  await sql`insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at) values (${id}, ${u}, 'birthday', 'n', 'solar', 3, 5, 1, 1)`;
  let msg = '';
  try {
    await baseStore.writeRemind('anniversaries', id, u, { remind_at: 1, next_date: 'not-a-date' }, null);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assertEquals(msg, 'db:data', '日期格式错（SQLSTATE 22007）应抛 db:data');
  assertEquals(await baseStore.writeRemind('anniversaries', id, u, { remind_at: 2, next_date: '2027-03-05' }, null), true, '合格的值照常写回');
  console.log('[R411-data] 真 PostgREST 回 22007：store 抛 db:data；合格的值照常写回');
} });

// R-411 后续（迁移 20261113160000）：finish 换签名 (p_claim, p_release, p_done)。真 PostgREST 上：新 store 传处理完的名单，只删名单里的，
// 两份都没列的留着租约；旧版只按名字传 p_claim、p_release 也调得到新函数（p_done 默认 null），照旧删这个租约里其余的
Deno.test({ name: 'R-411 finish 处理完的名单（真库）：新 store 只删 p_done 里的、都没列的留着租约；旧版两个参数照样调得通', ...opts, async fn() {
  const u = await mkUser('d3-done');
  const k = crypto.randomUUID();
  const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await sql`insert into private.remind_queue (table_name, id, user_id, claim, claimed_at, attempts)
    select 'todos', x, ${u}, ${k}, now(), 1 from unnest(${[a, b, c]}::uuid[]) x`;
  const ref = (id: string) => ({ table_name: 'todos' as const, id, user_id: u, claim: k, fresh: false, prio: 0 });
  await baseStore.finishQueue(k, [ref(a)], [ref(b)]);
  const state = async () => (await sql`select id, claim is null as freed, attempts, claimed_at is not null as has_at from private.remind_queue
    where id = any(${[a, b, c]}::uuid[])`).map((r) => `${r.id === a ? 'a' : r.id === b ? 'b' : 'c'}:${r.freed}:${r.attempts}:${r.has_at}`).sort().join(',');
  assertEquals(await state(), 'a:true:0:true,c:false:1:true', 'a 放回（claimed_at 留着）、b 删掉、都没列的 c 留着租约');
  const { error } = await admin.schema('private').rpc('remind_queue_finish', { p_claim: k, p_release: [] });
  assertEquals(error, null, '旧版按名字只传 p_claim、p_release 调得到新函数');
  assertEquals(await state(), 'a:true:0:true', '旧口径：这个租约里不在 p_release 的 c 删掉');
  await sql`delete from private.remind_queue where user_id = ${u}`;
  console.log('[R411-done] 真 PostgREST：p_done 只删名单里的、都没列的留着；旧版两参数调用照旧删其余');
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
