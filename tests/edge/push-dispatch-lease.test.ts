// push-dispatch 第 0 步的租约式出队（REMIND-queue-crash-loss 方案丙，R-348；迁移 20261104130000；架构 5.3 第 0 步、0.49 第 3 条）。
// 函数一侧：中途崩了（没调 finish）租约过期后重取并算对；处理期间同一行被改，finish 不删、下一轮（下一分钟）按新值算；放回的下一轮马上能取；
// 写回出错的留着租约（迁移 20261113120000），和崩了一样过期重取、计入有毒次数；
// 取过 5 次都没处理完的丢掉、记 queue_poison；finish 失败记 queue_finish_failed、等租约过期。
// SQL 本身（打租约、过期、skip locked、4 个入队入口清租约、attempts）在 supabase/tests/rls/30_remind_queue_pop.test.sql。
import { describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { handle, QUEUE_LEASE_S } from '../../supabase/functions/push-dispatch/core.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { DB_DATA } from '../../supabase/functions/push-dispatch/round.ts';
import { MemDb, POISON_AT, todoRow, UA } from './push-dispatch-mem.ts';

const SEOUL = 'Asia/Seoul';
const at = (hm: string, day = '2026-11-03') => msAt(day, parseHm(hm), SEOUL);
const S = 1000;

async function run(db: MemDb, now: number) {
  db.clock = () => now;
  const { keys } = await fakeVapid();
  const d = depsFor(db, keys, { now: () => now, fetch: async () => new Response(null, { status: 201 }) });
  expect((await handle(cronReq(), d)).status).toBe(200);
  return d;
}
const want = (due: string) => msAt(due, 540, SEOUL);   // remind_days = 0、没设 remind_time：当天 09:00

describe('第 0 步租约：崩溃以后', () => {
  it('租约是 180 秒', () => {
    expect(QUEUE_LEASE_S).toBe(180);
  });
  it('取走以后进程死了（没调 finish）：179 秒内别的轮不重取，过了 180 秒重取、算对、队列清空', async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    const t0 = at('10:00');
    db.clock = () => t0;
    expect((await db.popQueue(500, QUEUE_LEASE_S)).map((x) => x.id)).toEqual([t.id]);   // 崩掉的那一轮：取走就死了
    db.calls.length = 0;
    await run(db, t0 + 179 * S);
    expect(db.calls).not.toContain('rows');   // 租着、没过期：这一轮第 0 步什么都没取到
    expect(db.tables.todos.get(t.id)?.remind_at).toBeNull();
    expect(db.queue.get(`todos:${t.id}`)?.claim).toBeTruthy();
    await run(db, t0 + 181 * S);
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(want('2026-11-05'));
    expect(db.queue.size).toBe(0);
  });
  it('finish 失败：记 queue_finish_failed，项留着（租着）；下一分钟不重算，租约过期后重取一次、结果一样不写回，然后删掉', async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    db.failOn.add('finishQueue');
    const d = await run(db, at('10:00'));
    expect(d.codes).toContain('queue_finish_failed');
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(want('2026-11-05'));
    expect(db.queue.get(`todos:${t.id}`)?.claim).toBeTruthy();
    db.failOn.clear();
    db.calls.length = 0;
    await run(db, at('10:01'));
    expect(db.calls).not.toContain('rows');
    await run(db, at('10:04'));
    expect(db.calls.filter((x) => x === 'writeRemind')).toEqual([]);   // 重算结果相同（same），不写回
    expect(db.queue.size).toBe(0);
  });
});

describe('第 0 步租约：处理期间这一行又被改了', () => {
  it('读完、写回之前用户改了截止日：触发器清租约、attempts 清零，finish 不删；下一轮当新项按新值重算', async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    const rows = db.rows.bind(db);
    let edited = false;
    db.rows = async (table, ids) => {
      const r = await rows(table, ids);
      if (!edited) {
        edited = true;
        db.edit('todos', t.id, { due: '2026-11-09' });   // 同一时刻另一端改了这一行（enqueue_remind：清租约）
      }
      return r;
    };
    const writes: (number | null)[] = [];
    const wr = db.writeRemind.bind(db);
    db.writeRemind = async (table, id, user, patch, prev) => {
      writes.push(patch.remind_at);
      return wr(table, id, user, patch, prev);
    };
    await run(db, at('10:00'));
    // 第一次按读到的旧值写了 11-05（乐观条件只看 remind_at，编辑没动 remind_at），项留在队列里、租约已清、attempts 清零
    expect(writes).toEqual([want('2026-11-05')]);
    expect(db.queue.get(`todos:${t.id}`)).toMatchObject({ claim: null, attempts: 0 });
    // 新项每轮按批出队一次（11-05 安全复审 N1），下一分钟按新值写成 11-09，然后删掉
    await run(db, at('10:01'));
    expect(writes).toEqual([want('2026-11-05'), want('2026-11-09')]);
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(want('2026-11-09'));
    expect(db.queue.size).toBe(0);
  });
});

describe('第 0 步租约：放回、有毒项', () => {
  it('写回遇到数据类错误不放回：租约、attempts 留着（同“中途崩了”），179 秒内不重取，过期后按重试取到、写成、删掉', async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    db.dataOn.add('writeRemind');
    const t0 = at('10:00');
    const d = await run(db, t0);
    expect(d.codes).toEqual(expect.arrayContaining(['recalc_write_failed:data', `recalc:held:todos:${t.id.slice(0, 8)}`]));
    expect(db.logs.filter((l) => l.act === 'recalc').map((l) => l.code)).toEqual(['held']);   // prio 0 的 held 进 logs
    const k = db.queue.get(`todos:${t.id}`)?.claim;
    expect(k).toBeTruthy();
    expect(db.queue.get(`todos:${t.id}`)).toMatchObject({ attempts: 1, claimed_at: t0 });
    db.dataOn.clear();
    await run(db, t0 + 179 * S);
    expect(db.tables.todos.get(t.id)?.remind_at).toBeNull();
    expect(db.queue.get(`todos:${t.id}`)?.claim).toBe(k);
    await run(db, t0 + 181 * S);
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(want('2026-11-05'));
    expect(db.queue.size).toBe(0);
  });
  it(`写回一直是数据类错误：每次过期重取计一次，取满 ${POISON_AT} 次后第 ${POISON_AT + 1} 次丢掉、记 queue_poison，不再每分钟重算`, async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    db.dataOn.add('writeRemind');
    let now = at('10:00');
    for (let i = 0; i < POISON_AT; i++) {
      const d = await run(db, now);
      expect(d.codes).toContain('recalc_write_failed:data');
      expect(db.queue.get(`todos:${t.id}`)?.attempts).toBe(i + 1);
      now += (QUEUE_LEASE_S + 1) * S;
    }
    expect(db.calls.filter((c) => c === 'writeRemind')).toHaveLength(POISON_AT);
    const d = await run(db, now);
    expect(d.codes).toContain(`queue_poison:todos:${t.id.slice(0, 8)}`);
    expect(db.queue.size).toBe(0);
    expect(db.calls.filter((c) => c === 'writeRemind')).toHaveLength(POISON_AT);
    await run(db, now + 60 * S);
    expect(db.calls.filter((c) => c === 'writeRemind')).toHaveLength(POISON_AT);
  });
  it('写回超时、别的数据库错误（连不上、5xx）：照旧放回、attempts 退回 0、不计有毒次数，故障过去下一分钟就算到', async () => {
    for (const inject of ['timeoutOn', 'failOn'] as const) {
      const db = new MemDb().user(UA);
      const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
      db[inject].add('writeRemind');
      let now = at('10:00');
      for (let i = 0; i < POISON_AT + 3; i++) {   // 故障持续得比有毒次数还久：每分钟一轮，一直放回
        const d = await run(db, now);
        expect(d.codes, inject).toContain(inject === 'timeoutOn' ? 'recalc_write_failed:timeout' : 'recalc_write_failed');
        expect(d.codes, inject).toContain(`recalc:released:todos:${t.id.slice(0, 8)}`);
        expect(db.queue.get(`todos:${t.id}`), inject).toMatchObject({ claim: null, attempts: 0 });
        now += 60 * S;
      }
      db[inject].clear();
      const d = await run(db, now);
      expect(d.codes.some((c) => c.startsWith('queue_poison')), inject).toBe(false);
      expect(db.tables.todos.get(t.id)?.remind_at, inject).toBe(want('2026-11-05'));
      expect(db.queue.size, inject).toBe(0);
      expect(db.logs.filter((l) => l.act === 'recalc').map((l) => l.code), inject).toEqual(['written']);   // released 不进 logs
    }
  });
  it('同一批里写成的、数据类错误 hold 的、乐观条件不成立放回的混在一起：各走各的，finish 一次收尾', async () => {
    const db = new MemDb().user(UA);
    const ok = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    const bad = db.put('todos', todoRow(UA, { due: '2026-11-06', remind_days: 0, remind_at: null }), true);
    const raced = db.put('todos', todoRow(UA, { due: '2026-11-07', remind_days: 0, remind_at: null }), true);
    const wr = db.writeRemind.bind(db);
    db.writeRemind = async (table, id, user, patch, prev, prevNotified) => {
      if (id === bad.id) throw new Error(DB_DATA);
      if (id === raced.id) return false;   // 读完以后行又被改了
      return wr(table, id, user, patch, prev, prevNotified);
    };
    const t0 = at('10:00');
    const d = await run(db, t0);
    expect(db.calls.filter((c) => c === 'finishQueue')).toHaveLength(1);
    expect(db.tables.todos.get(ok.id)?.remind_at).toBe(want('2026-11-05'));
    expect(db.queue.has(`todos:${ok.id}`)).toBe(false);                                         // 写成：删掉
    expect(db.queue.get(`todos:${bad.id}`)).toMatchObject({ attempts: 1, claimed_at: t0 });    // hold：租约留着
    expect(db.queue.get(`todos:${bad.id}`)?.claim).toBeTruthy();
    expect(db.queue.get(`todos:${raced.id}`)).toMatchObject({ claim: null, attempts: 0, claimed_at: t0 });   // 放回（claimed_at 留着，迁移 20261113160000）
    expect(d.codes).toEqual(expect.arrayContaining([`recalc:written:todos:${ok.id.slice(0, 8)}`, `recalc:held:todos:${bad.id.slice(0, 8)}`,
      `recalc:released:todos:${raced.id.slice(0, 8)}`, 'recalc_write_failed:data']));
    expect(db.logs.filter((l) => l.act === 'recalc').map((l) => [l.item_id, l.code]).sort()).toEqual([[ok.id, 'written'], [bad.id, 'held']].sort());
  });
  it('hold 期间用户又改了这一行：入队清租约、attempts 归 0，下一分钟当新项按新值算（不等租约过期）', async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    db.dataOn.add('writeRemind');
    await run(db, at('10:00'));
    expect(db.queue.get(`todos:${t.id}`)).toMatchObject({ attempts: 1 });
    db.dataOn.clear();
    db.edit('todos', t.id, { due: '2026-11-08' });
    expect(db.queue.get(`todos:${t.id}`)).toMatchObject({ claim: null, claimed_at: null, attempts: 0, fresh: true });
    await run(db, at('10:01'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(want('2026-11-08'));
    expect(db.queue.size).toBe(0);
  });
  it('读行失败：整批放回，记 recalc_read_failed', async () => {
    const db = new MemDb().user(UA);
    const a = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    const b = db.put('todos', todoRow(UA, { due: '2026-11-06', remind_days: 0 }), true);
    db.failOn.add('profiles');
    const d = await run(db, at('10:00'));
    expect(d.codes).toContain('recalc_read_failed');
    for (const x of [a, b]) expect(db.queue.get(`todos:${x.id}`)).toMatchObject({ claim: null, attempts: 0 });
  });
  it(`连崩 ${POISON_AT} 次的项：第 ${POISON_AT + 1} 次丢掉、记 queue_poison，不再重算；同批别的项照常算`, async () => {
    expect(POISON_AT).toBe(5);
    const db = new MemDb().user(UA);
    const bad = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_at: null }), true);
    let now = at('10:00');
    for (let i = 0; i < POISON_AT; i++) {
      db.clock = () => now;
      expect(await db.popQueue(500, QUEUE_LEASE_S, i > 0)).toHaveLength(1);   // 每次取走都崩（第 1 次是新项，之后是重试）
      now += (QUEUE_LEASE_S + 1) * S;
    }
    expect(db.queue.get(`todos:${bad.id}`)?.attempts).toBe(POISON_AT);
    const good = db.put('todos', todoRow(UA, { due: '2026-11-06', remind_days: 0, remind_at: null }), true);
    const d = await run(db, now);
    expect(d.codes.filter((c) => c.startsWith('queue_poison:'))).toEqual([`queue_poison:todos:${bad.id.slice(0, 8)}`]);   // 日志带表和 id 前 8 位
    expect(db.queue.size).toBe(0);
    expect(db.tables.todos.get(bad.id)?.remind_at).toBeNull();   // 有毒项不再处理
    expect(db.tables.todos.get(good.id)?.remind_at).toBe(want('2026-11-06'));
  });
  it('全是有毒项：只记 queue_poison:<表>:<id 前 8 位>，不读行、不调 finish；prio 0 的另进 logs（act = recalc、code = poison），批量的不进', async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    const b = db.put('todos', todoRow(UA, { due: '2026-11-06', remind_days: 0 }));
    db.queue.set(`todos:${t.id}`, { table_name: 'todos', id: t.id, claim: null, claimed_at: null, attempts: POISON_AT });
    db.queue.set(`todos:${b.id}`, { table_name: 'todos', id: b.id, prio: 1, claim: null, claimed_at: null, attempts: POISON_AT });
    const d = await run(db, at('10:00'));
    expect([...d.codes].sort()).toEqual([`queue_poison:todos:${t.id.slice(0, 8)}`, `queue_poison:todos:${b.id.slice(0, 8)}`].sort());
    expect(db.calls).not.toContain('rows');
    expect(db.calls).not.toContain('finishQueue');
    expect(db.logs.filter((l) => l.act === 'recalc').map((l) => [l.item_id, l.code, l.coll])).toEqual([[t.id, 'poison', 'todos']]);
  });
});
