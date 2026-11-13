// push-dispatch 第 0 步（原 tz-recalc；B2 任务单 BE-2 第 0 步、TZ-invalid-b2、K3-remind-orphan；架构 5.3 第 0 步、4.5、4.6、0.42 第 1 条、0.54 第 2 条；
// 代码审查 BE-1 R1）。出队函数本身（孤儿照常出队、停用和冷静期不出队、上限、prio 排序）在 supabase/tests/rls/30_remind_queue_pop.test.sql；这里测函数一侧：
// 重算时传这一行原来的 remind_at、漏传就失败、时区不认识的跳过记 tz_invalid、写回失败放回、预算到了放回。
// 11-04 起出队是租约式（迁移 20261104130000）：“放回”= finish 时清租约，崩溃、有毒项、处理期间被改在 push-dispatch-lease.test.ts。
import { describe, expect, it, vi } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import type { ItemRow, RoundLogic } from '../../supabase/functions/push-dispatch/round.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { eventRow, LOGIC, MemDb, todoRow, UA, UB, uuid } from './push-dispatch-mem.ts';

const SEOUL = 'Asia/Seoul';
const at = (hm: string, day = '2026-11-03') => msAt(day, parseHm(hm), SEOUL);

/** 已有的行被改了、照 update 触发器入队（不是 fresh；insert 入队的待办是 fresh，见 R-411 Q2） */
function edited(db: MemDb, table: 'todos' | 'events', row: ItemRow): ItemRow {
  db.put(table, row);
  db.enqueue(table, row.id);
  return row;
}

async function run(db: MemDb, now: number, logic: RoundLogic = LOGIC) {
  const { keys } = await fakeVapid();
  const d = depsFor(db, keys, { now: () => now, logic, fetch: async () => new Response(null, { status: 201 }) });
  const r = await handle(cronReq(), d);
  expect(r.status).toBe(200);
  return d;
}

describe('第 0 步：重算 remind_at 时一律传这一行原来的 remind_at（代码审查 BE-1 R1）', () => {
  it('待办、日程都传第 5 个参数，值就是行里现在的 remind_at（null 也照传，不是 undefined）；只有 fresh 的待办传 undefined（R-411 Q2）', async () => {
    const db = new MemDb().user(UA);
    const t1 = edited(db, 'todos', todoRow(UA, { due: '2026-11-04', due_time: '17:00', remind_before_min: 60, remind_at: at('16:00', '2026-11-04') }));
    const t2 = edited(db, 'todos', todoRow(UA, { due: '2026-11-04', remind_days: 0, remind_at: null }));
    const e1 = db.put('events', eventRow(UA, { date: '2026-11-04', time: '15:00', tz: SEOUL, remind_min: 15, remind_at: 123 }), true);
    const t3 = db.put('todos', todoRow(UA, { due: '2026-11-04', due_time: '17:00', remind_before_min: 60, remind_at: 456 }), true);   // 新建：fresh
    const spy = vi.fn(LOGIC.remindAtOf);
    await run(db, at('10:00'), { ...LOGIC, remindAtOf: spy });
    expect(spy).toHaveBeenCalledTimes(4);
    const byRow = new Map(spy.mock.calls.map((c) => [c[1].id, c]));
    for (const [row, prev] of [[t1, t1.remind_at], [t2, null], [e1, 123], [t3, undefined]] as const) {
      const call = byRow.get(row.id);
      expect(call, row.id).toBeDefined();
      // 11-04 全天日程：日程分支多传第 6 个参数 remind.default_time（这个人没设，是 undefined）；待办仍是 5 个
      expect(call).toHaveLength(row === e1 ? 6 : 5);
      expect(call?.[4]).toBe(prev);
    }
    expect(byRow.get(t1.id)?.[2]).toBe(SEOUL);   // 待办按 current_tz
  });

  // 0.54 第 2 条的场景：16:00 推过，16:02 按“稍后”写 snooze_at = 16:12 → 入队重算。传了原值（16:00）就保持 16:00，due_at = 16:12 照常响；
  // 漏传就回落到截止时刻 17:00，稍后这次被吞掉
  const scenario = () => {
    const db = new MemDb().user(UA);
    const row = edited(db, 'todos', todoRow(UA, { due: '2026-11-03', due_time: '17:00', remind_before_min: 60, remind_at: at('16:00'), pushed_for: at('16:00'), snooze_at: at('16:12') }));
    return { db, row };
  };
  it('传了：remind_at 保持 16:00，不写回', async () => {
    const { db, row } = scenario();
    await run(db, at('16:02'));
    expect(db.tables.todos.get(row.id)?.remind_at).toBe(at('16:00'));
    expect(db.calls).not.toContain('writeRemind');
  });
  it('漏传就失败：同一个场景换成不传 prevRemindAt 的实现，上一条的断言就不成立（证明上一条钉得住）', async () => {
    const { db, row } = scenario();
    const dropPrev: RoundLogic['remindAtOf'] = (kind, r, tz, now) =>
      (LOGIC.remindAtOf as (...a: unknown[]) => number | null)(kind, r, tz, now);   // 故意只传 4 个参数
    await run(db, at('16:02'), { ...LOGIC, remindAtOf: dropPrev });
    expect(db.tables.todos.get(row.id)?.remind_at).not.toBe(at('16:00'));
    expect(db.tables.todos.get(row.id)?.remind_at).toBe(at('17:00'));
  });
});

describe('第 0 步：出队、写回、按租约收尾', () => {
  it('换时区：按新的 current_tz 重算待办；日程是固定时刻不变；处理完队列清空', async () => {
    const db = new MemDb().user(UA, { current_tz: 'America/Los_Angeles' });
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0, remind_time: '09:00', remind_at: msAt('2026-11-05', 540, SEOUL) }), true);
    const e = db.put('events', eventRow(UA, { date: '2026-11-05', time: '15:00', tz: SEOUL, remind_min: 15, remind_at: msAt('2026-11-05', 885, SEOUL) }), true);
    await run(db, at('10:00'));
    expect(db.tables.todos.get(t.id)?.remind_at).toBe(msAt('2026-11-05', 540, 'America/Los_Angeles'));
    expect(db.tables.events.get(e.id)?.remind_at).toBe(msAt('2026-11-05', 885, SEOUL));
    expect(db.queue.size).toBe(0);
  });
  it('账号不可用的不出队（恢复后下一轮照常重算）；目标行已不在的（孤儿）照常出队、读不到行，收尾时删掉', async () => {
    const db = new MemDb().user(UA).user(UB, {}, false);
    const tb = db.put('todos', todoRow(UB, { due: '2026-11-05', remind_days: 0 }), true);
    db.queue.set('todos:orphan', { table_name: 'todos', id: '99999999-0000-4000-8000-000000000000', user_id: UA });
    await run(db, at('10:00'));
    expect([...db.queue.keys()]).toEqual([`todos:${tb.id}`]);
    expect(db.tables.todos.get(tb.id)?.remind_at).toBeNull();
    db.usable.set(UB, true);
    await run(db, at('10:01'));
    expect(db.queue.size).toBe(0);
    expect(db.tables.todos.get(tb.id)?.remind_at).toBe(msAt('2026-11-05', 540, SEOUL));
  });
  it('写回失败的放回队列，下一轮再算', async () => {
    const db = new MemDb().user(UA);
    const t = db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    db.failOn.add('writeRemind');
    await run(db, at('10:00'));
    expect([...db.queue.keys()]).toEqual([`todos:${t.id}`]);
    db.failOn.clear();
    await run(db, at('10:01'));
    expect(db.queue.size).toBe(0);
  });
  it('时间预算到了：出队以后没来得及处理的放回', async () => {
    const db = new MemDb().user(UA);
    db.put('todos', todoRow(UA, { due: '2026-11-05', remind_days: 0 }), true);
    db.put('todos', todoRow(UA, { due: '2026-11-06', remind_days: 0 }), true);
    let now = at('10:00');
    const pop = db.popQueue.bind(db);
    db.popQueue = async (...a) => {
      const r = await pop(...a);
      // 新项按批出队以后时钟跳过 20 秒预算。R-411 复核时发现原来每次出队都跳：先做的单项重试出队（取空）就把预算跳完了，
      // 按批那次根本没出队，这条一直空过；改成只在按批那次跳，并核对两项确实出过队
      if (!a[2]) now += 25_000;
      return r;
    };
    const { keys } = await fakeVapid();
    await handle(cronReq(), depsFor(db, keys, { now: () => now }));
    expect(db.calls.filter((c) => c === 'popQueue')).toHaveLength(2);
    expect([...db.queue.values()].map((q) => [q.claim, q.attempts])).toEqual([[null, 0], [null, 0]]);   // 放回：清租约、attempts 减回 0
    expect(db.calls).not.toContain('writeRemind');
  });
});

describe('第 0 步：不认识的时区那一行跳过、记 tz_invalid（D7，TZ-invalid-b2）', () => {
  it('日程自己的 tz 坏了、某人的 current_tz 坏了：各记一条 tz_invalid，code 分别是表名 events、profiles（11-04 起 current_tz 不认识统一记 profiles）；同批别的行照常重算', async () => {
    const db = new MemDb().user(UA).user(UB, { current_tz: 'Mars/Olympus_Mons' });
    const bad = db.put('events', eventRow(UA, { title: '机密会议', date: '2026-11-05', time: '15:00', tz: 'Not/AZone', remind_min: 15, remind_at: 1 }), true);
    const ok = db.put('events', eventRow(UA, { date: '2026-11-05', time: '15:00', tz: SEOUL, remind_min: 15 }), true);
    const tb = db.put('todos', todoRow(UB, { title: '机密待办', due: '2026-11-05', remind_days: 0, remind_at: 2 }), true);
    await run(db, at('10:00'));
    const tz = db.logs.filter((l) => l.act === 'tz_invalid');
    expect(tz.map((l) => [l.user_id, l.code]).sort()).toEqual([[UA, 'events'], [UB, 'profiles']].sort());
    for (const l of tz) expect(l.item_id === null && l.coll === null).toBe(true);
    const text = JSON.stringify(db.logs);
    for (const s of ['Not/AZone', 'Mars/Olympus_Mons', '机密会议', '机密待办']) expect(text).not.toContain(s);
    expect(db.tables.events.get(bad.id)?.remind_at).toBe(1);
    expect(db.tables.todos.get(tb.id)?.remind_at).toBe(2);
    expect(db.tables.events.get(ok.id)?.remind_at).toBe(msAt('2026-11-05', 885, SEOUL));
    expect(db.queue.size).toBe(0);   // 跳过的不放回（放回只会每分钟再记一次）：finish 按租约删掉
  });
  it('11-04：current_tz 不认识时纪念日也记 profiles（和待办、全天日程同一口径，R-316）', async () => {
    const db = new MemDb().user(UB, { current_tz: 'Mars/Olympus_Mons' });
    db.put('anniversaries', { id: uuid('a'), user_id: UB, deleted_at: null, undone: false, push_show_title: null, remind_at: 3, notified_for: null,
      snooze_at: null, pushed_for: null, defer_until: null, name: '妈妈生日', kind: 'birthday', calendar: 'solar', month: 11, day: 20 }, true);
    await run(db, at('10:00'));
    expect(db.logs.filter((l) => l.act === 'tz_invalid').map((l) => [l.user_id, l.code])).toEqual([[UB, 'profiles']]);
    expect(db.queue.size).toBe(0);
  });
});

describe('第 0 步：有时刻但 tz 为空的日程（PUSH-tz-null-event，11-04 主持人定：以 eventRemindAt 和 0002 约束为准）', () => {
  // 真库里这种行存不进来（0002：check (time is null or tz is not null)）；替身里造出来，核对服务器和 shared 同一口径：不提醒、不记原因码
  for (const tz of [SEOUL, 'America/Los_Angeles']) {
    it(`current_tz = ${tz}：remind_at 算成 null（原来有值也清掉），到点不推，不记 tz_invalid`, async () => {
      const db = new MemDb().user(UA, { current_tz: tz });
      const row = db.put('events', eventRow(UA, { date: '2026-11-03', time: '15:00', tz: null, remind_min: 15, remind_at: at('14:45') }), true);
      const d = await run(db, at('14:45'));
      expect(db.tables.events.get(row.id)?.remind_at).toBeNull();
      expect(db.logs.filter((l) => l.act === 'tz_invalid')).toEqual([]);
      expect(d.codes.filter((c) => c.startsWith('recalc:failed:'))).toEqual([]);
      expect(db.logs.filter((l) => l.act === 'push_ok')).toEqual([]);
    });
  }
  it('tz 是乱写的值：照旧跳过、记 events（不写回，remind_at 保持原值）', async () => {
    const db = new MemDb().user(UA);
    const row = db.put('events', eventRow(UA, { date: '2026-11-03', time: '15:00', tz: 'Nowhere/Atlantis', remind_min: 15, remind_at: 7 }), true);
    await run(db, at('10:00'));
    expect(db.logs.filter((l) => l.act === 'tz_invalid').map((l) => l.code)).toEqual(['events']);
    expect(db.tables.events.get(row.id)?.remind_at).toBe(7);
  });
});
