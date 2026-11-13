// push-dispatch 第 0 步租约式出队的审查返工（11-04；代码审查 H1、L2，安全审查必改 1～3；迁移 20261104130000）：
// ① 重试模式：一批里有一项一算就崩，同批别的项不被连坐（5 轮以后还在、而且算对了），只有那一项被丢掉；
// ② finish 的放回和删除跳过被用户事务锁着的行（skip locked），不整批失败；
// ③ 一轮最多做 QUEUE_RETRY_POPS 次单项重试，之后每轮都再做一次新项按批出队（11-05 安全复审 N1：重试项挡不住别人新改的项）；
// ④ 心跳的 queue_ok、queue_poison（首尔当天累计）。
// SQL 一侧同样的场景在 supabase/tests/rls/30_remind_queue_pop.test.sql ⑮；真库两连接的锁等待在 tools/db/remind-queue-2conn.mjs。
import { describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { handle, QUEUE_LEASE_S, QUEUE_RETRY_MS, QUEUE_RETRY_POPS, seoulDay, type HeartbeatDetail } from '../../supabase/functions/push-dispatch/core.ts';
import type { Limits } from '../../supabase/functions/push-dispatch/round-types.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { MemDb, POISON_AT, todoRow, UA, UB } from './push-dispatch-mem.ts';

const SEOUL = 'Asia/Seoul';
const at = (hm: string, day = '2026-11-03') => msAt(day, parseHm(hm), SEOUL);
const S = 1000;
const want = (due: string) => msAt(due, 540, SEOUL);   // remind_days = 0、没设 remind_time：当天 09:00

/** 跑一轮；rows 卡住不返回的就当“进程死了”（等 50 毫秒还没结束就放弃这一轮，不写心跳、不调 finish） */
async function round(db: MemDb, now: number): Promise<{ crashed: boolean; codes: string[] }> {
  db.clock = () => now;
  const { keys } = await fakeVapid();
  const d = depsFor(db, keys, { now: () => now, fetch: async () => new Response(null, { status: 201 }) });
  const done = handle(cronReq(), d).then(() => false);
  const crashed = await Promise.race([done, new Promise<boolean>((r) => setTimeout(() => r(true), 50))]);
  return { crashed, codes: d.codes };
}
/** 读到 id 这一行就卡死（模拟“一算就崩”：CPU 硬上限、死循环） */
function crashOn(db: MemDb, id: string): void {
  const rows = db.rows.bind(db);
  db.rows = async (table, ids) => (ids.includes(id) ? new Promise(() => {}) : rows(table, ids));
}

describe('重试模式：有毒项不连坐同批的项（H1）', () => {
  it(`bad 和 innocent 同批、bad 每次都崩：innocent 单独重算、算对；只有 bad 在取过 ${POISON_AT} 次后被丢掉`, async () => {
    const db = new MemDb().user(UA).user(UB);
    const bad = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    const innocent = db.put('todos', todoRow(UB, { due: '2026-11-07', remind_days: 0, remind_at: null }), true);
    crashOn(db, bad.id);
    let now = at('10:00');
    const crashes: boolean[] = [];
    let poison = 0;
    for (let i = 0; i < 8; i++) {
      const r = await round(db, now);
      crashes.push(r.crashed);
      poison += r.codes.filter((c) => c.startsWith('queue_poison:')).length;
      now += (QUEUE_LEASE_S + 1) * S;
    }
    // 第 1 轮两项同批一起崩；第 2～5 轮 bad 单独取、单独崩（第 3 轮先把 innocent 单独算完）；第 6 轮 bad 取过 5 次、被丢掉
    expect(crashes).toEqual([true, true, true, true, true, false, false, false]);
    expect(poison).toBe(1);
    expect(db.tables.todos.get(innocent.id)?.remind_at).toBe(want('2026-11-07'));   // innocent 还在、算对了
    expect(db.tables.todos.get(bad.id)?.remind_at).toBeNull();
    expect(db.queue.size).toBe(0);
    expect((db.beats.at(-1) as HeartbeatDetail).queue_poison).toBe(1);   // 首尔当天累计，后面两轮没有新的也还是 1
  });
  it('原来的连坐场景（整批每项都 + 1）不再出现：一批崩过一次后，同批的项各自单独出队，attempts 只有 bad 在涨', async () => {
    const db = new MemDb().user(UA).user(UB);
    const bad = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    const others = [1, 2, 3].map((i) => db.put('todos', todoRow(UB, { due: `2026-11-1${i}`, remind_days: 0 }), true));
    crashOn(db, bad.id);
    let now = at('10:00');
    await round(db, now);   // 第 1 批四项一起崩，attempts 都是 1
    now += (QUEUE_LEASE_S + 1) * S;
    await round(db, now);   // 重试模式：先 bad（键最小）单独崩，其余三项这一轮没轮到
    now += (QUEUE_LEASE_S + 1) * S;
    await round(db, now);   // 三项 attempts 1 先单独算完，再取 bad 又崩
    expect(db.queue.get(`todos:${bad.id}`)?.attempts).toBe(3);
    for (const o of others) expect(db.queue.has(`todos:${o.id}`)).toBe(false);
    expect(others.map((o) => db.tables.todos.get(o.id)?.remind_at)).toEqual([1, 2, 3].map((i) => want(`2026-11-1${i}`)));
  });
});

describe('一轮最多调 QUEUE_RETRY_POPS 次出队', () => {
  it(`25 项都取过（上一批崩了）：一轮只单独处理 ${QUEUE_RETRY_POPS} 项，余下的下一轮接着`, async () => {
    expect(QUEUE_RETRY_POPS).toBe(20);
    const db = new MemDb().user(UA);
    const now = at('10:00');
    const ts = Array.from({ length: 25 }, (_, i) => db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, title: `t${i}` }), true));
    for (const t of ts) db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: 'old', claimed_at: now - 3600 * S, attempts: 1 });
    db.calls.length = 0;
    await round(db, now);
    expect(db.calls.filter((c) => c === 'popQueue')).toHaveLength(QUEUE_RETRY_POPS + 1);   // 20 次单项重试，再加 1 次新项按批
    expect(db.calls.filter((c) => c === 'finishQueue')).toHaveLength(QUEUE_RETRY_POPS);
    expect(db.queue.size).toBe(5);
    await round(db, now + 60 * S);
    expect(db.queue.size).toBe(0);
  });
});

describe('重试项挡不住新项（11-05 安全复审 N1、代码审查 M1）', () => {
  /** 时钟在每次出队后往前跳 stepMs，模拟慢的出队 */
  async function slowRound(db: MemDb, start: number, stepMs: number, limits: Partial<Limits> = {}) {
    let now = start;
    db.clock = () => now;
    const pop = db.popQueue.bind(db);
    db.popQueue = async (...a) => {
      const r = await pop(...a);
      now += stepMs;
      return r;
    };
    const { keys } = await fakeVapid();
    const d = depsFor(db, keys, { now: () => now, fetch: async () => new Response(null, { status: 201 }), limits });
    await handle(cronReq(), d);
    db.popQueue = pop;
    return d;
  }
  it('A 有 30 项重试项（上一批崩了）：同一轮做完 20 次单项重试以后，B 新改的项照样按批出队、算对', async () => {
    const db = new MemDb().user(UA).user(UB);
    const now = at('10:00');
    const olds = Array.from({ length: 30 }, (_, i) => db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, title: `o${i}` }), true));
    for (const t of olds) db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: 'old', claimed_at: now - 3600 * S, attempts: 1 });
    const fresh = db.put('todos', todoRow(UB, { due: '2026-11-07', remind_days: 0 }), true);
    await round(db, now);
    expect(db.tables.todos.get(fresh.id)?.remind_at).toBe(want('2026-11-07'));
    expect(db.queue.has(`todos:${fresh.id}`)).toBe(false);
    expect(db.queue.size).toBe(10);   // A 的 30 项做了 20 项
  });
  it(`单项重试只在这一轮开头 ${QUEUE_RETRY_MS} 毫秒内做：出队慢的时候提前停，新项照样按批出队`, async () => {
    expect(QUEUE_RETRY_MS).toBe(5000);
    const db = new MemDb().user(UA).user(UB);
    const now = at('10:00');
    const olds = Array.from({ length: 10 }, (_, i) => db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, title: `o${i}` }), true));
    for (const t of olds) db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: 'old', claimed_at: now - 3600 * S, attempts: 1 });
    const fresh = db.put('todos', todoRow(UB, { due: '2026-11-07', remind_days: 0 }), true);
    db.calls.length = 0;
    await slowRound(db, now, 2000);   // 每次出队 2 秒：第 3 次重试开始前已过 4 秒、第 4 次前 6 秒，停
    expect(db.calls.filter((c) => c === 'popQueue')).toHaveLength(4);   // 3 次重试 + 1 次新项
    expect(db.tables.todos.get(fresh.id)?.remind_at).toBe(want('2026-11-07'));
    expect(db.queue.size).toBe(7);
  });
  it('总预算到了（代码审查 N1）：不再出队，不会把放回的同一项反复取出来', async () => {
    const db = new MemDb().user(UA);
    const now = at('10:00');
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: 'old', claimed_at: now - 3600 * S, attempts: 1 });
    db.calls.length = 0;
    await slowRound(db, now, 25_000);   // 第一次出队以后就过了 20 秒预算：这一项放回，之后不再取
    expect(db.calls.filter((c) => c === 'popQueue')).toHaveLength(1);
    expect(db.queue.get(`todos:${t.id}`)).toMatchObject({ claim: null, attempts: 1 });
  });
  it('单项重试的循环每次先看总预算（代码审查 N1）：重试时限放宽到 60 秒，总预算 20 秒先到，也不再取', async () => {
    const db = new MemDb().user(UA);
    const now = at('10:00');
    const olds = Array.from({ length: 5 }, (_, i) => db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, title: `o${i}` }), true));
    for (const t of olds) db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: 'old', claimed_at: now - 3600 * S, attempts: 1 });
    db.calls.length = 0;
    await slowRound(db, now, 8_000, { queueRetryMs: 60_000 });   // 每次出队 8 秒：第 3 次之前已过 16 秒，第 4 次之前 24 秒 > 20 秒，停
    expect(db.calls.filter((c) => c === 'popQueue')).toHaveLength(3);
  });
  it('没有重试项的一轮只出队两次（重试取空就停、再做一次新项）；出队失败只调一次、只记一次 queue_pop_failed', async () => {
    const db = new MemDb().user(UA);
    db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    db.calls.length = 0;
    await round(db, at('10:00'));
    expect(db.calls.filter((c) => c === 'popQueue')).toHaveLength(2);
    expect(db.queue.size).toBe(0);
    const bad = new MemDb().user(UA);
    bad.failOn.add('popQueue');
    bad.calls.length = 0;
    const r = await round(bad, at('10:00'));
    expect(bad.calls.filter((c) => c === 'popQueue')).toHaveLength(1);
    expect(r.codes.filter((c) => c === 'queue_pop_failed')).toHaveLength(1);
  });
});

describe('finish 跳过被用户事务锁着的行（安全审查必改 2）', () => {
  it('同批一项被锁着：finish 不报错、不整批失败；锁着的那项租约留着，其余照常删；租约过期后单独重取、算完', async () => {
    const db = new MemDb().user(UA).user(UB);
    const a = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    const b = db.put('todos', todoRow(UB, { due: '2026-11-06', remind_days: 0 }), true);
    db.locked.add(`todos:${a.id}`);
    const r1 = await round(db, at('10:00'));
    expect(r1.codes).not.toContain('queue_finish_failed');
    expect((db.beats.at(-1) as HeartbeatDetail).queue_ok).toBe(1);
    expect(db.queue.has(`todos:${b.id}`)).toBe(false);
    expect(db.queue.get(`todos:${a.id}`)).toMatchObject({ attempts: 1 });
    expect(db.queue.get(`todos:${a.id}`)?.claim).toBeTruthy();
    db.locked.clear();   // 用户事务回滚了（提交了的话触发器会清租约、attempts 清零，下一分钟就按新值算）
    await round(db, at('10:00') + (QUEUE_LEASE_S + 1) * S);
    expect(db.queue.size).toBe(0);
    expect(db.tables.todos.get(a.id)?.remind_at).toBe(want('2026-11-05'));
  });
});

describe('心跳的 queue_ok、queue_poison（安全审查必改 3）', () => {
  it('出队失败、收尾失败、读行失败：queue_ok = 0；正常一轮 = 1', async () => {
    for (const fail of ['popQueue', 'finishQueue', 'profiles']) {
      const db = new MemDb().user(UA);
      db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
      db.failOn.add(fail);
      await round(db, at('10:00'));
      expect((db.beats.at(-1) as HeartbeatDetail).queue_ok, fail).toBe(0);
    }
    const db = new MemDb().user(UA);
    await round(db, at('10:00'));
    expect((db.beats.at(-1) as HeartbeatDetail).queue_ok).toBe(1);
  });
  it('整轮意外出错（round_failed 兜底）：心跳照写，queue_ok = 0、queue_poison 只算上一次的累计', async () => {
    const db = new MemDb().user(UA);
    const now = at('10:00');
    db.clock = () => now;
    const { keys } = await fakeVapid();
    const d = depsFor(db, keys, { now: () => now, fetch: async () => new Response(null, { status: 201 }) });
    Object.defineProperty(d, 'logic', { get: () => { throw new Error('boom'); } });
    await handle(cronReq(), d);
    expect(d.codes).toContain('round_failed');
    expect(db.beats.at(-1)).toMatchObject({ queue_ok: 0, queue_poison: 0 });
  });
  it('queue_poison 按首尔当天累计：同一天加上上一次的，换日（首尔 0 点）从这一轮重新算；响应体带累计值', async () => {
    const db = new MemDb().user(UA);
    const poisonOne = () => {
      const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }));
      db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: null, claimed_at: null, attempts: POISON_AT });
    };
    poisonOne();
    await round(db, at('23:50'));
    poisonOne();
    await round(db, at('23:55'));
    expect(db.beats.map((b) => b.queue_poison)).toEqual([1, 2]);
    await round(db, at('00:01', '2026-11-04'));
    expect((db.beats.at(-1) as HeartbeatDetail).queue_poison).toBe(0);
    poisonOne();
    const r = await round(db, at('00:05', '2026-11-04'));
    expect((db.beats.at(-1) as HeartbeatDetail).queue_poison).toBe(1);
    expect(r.codes).not.toContain('heartbeat_read_failed');   // 不再先读心跳（累加在 SQL 里，REMIND-poison-atomic）
    expect(db.calls).not.toContain('readHeartbeat');
  });
  it('handle 把这一轮的个数交给 writeHeartbeat、响应体用它返回的累计（累加在 private.push_heartbeat_write 里，不在函数里算）', async () => {
    const db = new MemDb().user(UA);
    const now = at('10:00');
    db.clock = () => now;
    const got: Array<[unknown, number]> = [];
    db.writeHeartbeat = async (d, poison) => { got.push([d, poison]); return 41 + poison; };
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }));
    db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: null, claimed_at: null, attempts: POISON_AT });
    const { keys } = await fakeVapid();
    const res = await handle(cronReq(), depsFor(db, keys, { now: () => now, fetch: async () => new Response(null, { status: 201 }) }));
    expect(got).toHaveLength(1);
    expect(got[0]?.[1]).toBe(1);
    expect(got[0]?.[0]).not.toHaveProperty('queue_poison');
    expect(((await res.json()) as HeartbeatDetail).queue_poison).toBe(42);
  });
  it('替身照 SQL：旧值不合格（不是对象、负数、小数、字符串、超 9 位）从这一轮重新算；这一轮负数、超大截到 0～100000', async () => {
    const db = new MemDb();
    const now = at('12:00');
    db.clock = () => now;
    const base = { claimed: 0, sent: 0, failed: 0, budget_hit: false, queue_ok: 1, recalc_written: 0, recalc_r336: 0, recalc_failed: 0 };
    for (const detail of [null, [], 'x', { queue_poison: -1 }, { queue_poison: 1.5 }, { queue_poison: '3' }, { queue_poison: 1_000_000_000 }, {}]) {
      db.lastBeat = { at: at('08:00'), detail };
      expect(await db.writeHeartbeat(base, 2), JSON.stringify(detail)).toBe(2);
    }
    db.lastBeat = { at: at('08:00'), detail: { queue_poison: 3 } };
    expect(await db.writeHeartbeat(base, 2)).toBe(5);
    expect(await db.writeHeartbeat(base, -5)).toBe(5);
    expect(await db.writeHeartbeat(base, 10_000_000)).toBe(100_005);
    expect(seoulDay(at('00:00'))).toBe(seoulDay(at('23:59')));
    expect(seoulDay(at('00:00', '2026-11-04'))).toBe(seoulDay(at('23:59')) + 1);
  });
});
