// R-411 后续（11-13 整块评审）：批量入队范围在 SQL（private.remind_enqueue 的 floating / allday / anniv / all 各支，迁移 20261113100000）
// 和内存替身（tests/edge/push-dispatch-mem.ts 的 MemDb.enqueueScope）里各写了一份。这里用同一批行把两边连起来：
// 真库上 select private.remind_enqueue(scope, …)，替身上 enqueueScope(scope, …)，比较两边入队的（表、id、prio）集合一模一样。
// 造的行覆盖各分支的边界：日期过两天以上、刚好两天；“稍后”、免打扰顺延在 1 小时窗口内外（含刚好 1 小时）；remind_at 刚好等于现在、
// 刚好 24 小时（prio 1 / 2 的分界）；没设提醒、有时刻的日程、有截止时刻却没提前量的待办、截止为空的待办；完成、删掉的；
// remind_at 为空的纪念日、自定义提醒的纪念日；另一个人的行（按人的几支不收）。
// 真库那边整个在一个事务里做、最后回滚：只留下两个测试用户（收尾删掉）；all 一支会把库里别人的行也入队，回滚后什么都不剩。
// 事务里 now() 不变，替身的时钟取同一个值（按 SQL 里 (extract(epoch from now()) * 1000)::bigint 的算法取），边界一毫秒不差。
// 跑法：由 supabase/tests/store-it/run.mjs 起（单独一个 deno 进程：harness 收尾会关库连接）。本机 npm run e2e:real:up →
//   node supabase/tests/store-it/run.mjs --e2e-sb → npm run e2e:real:down。
// 两边不一致时只报差在哪几行（用例名），不在这里判哪边对：口径以迁移里 remind_enqueue 上面的注释为准，改哪边由负责人或主持人定。
import { assertEquals, sql, ours, writeLedger, purgeTraces, healLeftovers, mkUser, releaseLock } from './harness.ts';
import { annivRow, eventRow, MemDb, todoRow, type EnqueueScope } from '../../../tests/edge/push-dispatch-mem.ts';
import type { ItemRow, Table } from '../../functions/push-dispatch/round.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
const DAY = 86_400_000;
const MIN = 60_000;

type Case = { name: string; table: Table; row: ItemRow };

/** 一批行：n 是事务里的“现在”（毫秒），a、b 是两个人；日期按 UTC（和 SQL 的 cut 同一口径） */
function cases(n: number, a: string, b: string): Case[] {
  const day = (k: number) => new Date(n + k * DAY).toISOString().slice(0, 10);
  const id = () => crypto.randomUUID();
  const ev = (name: string, user: string, over: Partial<ItemRow>): Case => ({ name, table: 'events', row: eventRow(user, { id: id(), ...over }) });
  const td = (name: string, user: string, over: Partial<ItemRow>): Case => ({ name, table: 'todos', row: todoRow(user, { id: id(), ...over }) });
  const an = (name: string, user: string, over: Partial<ItemRow>): Case => ({ name, table: 'anniversaries', row: annivRow(user, { id: id(), ...over }) });
  const timed = { time: '09:00', tz: 'Asia/Seoul' };
  return [
    // ---- 日程 ----
    ev('e 全天 过三天 没算', a, { date: day(-3), remind_days: 1 }),
    ev('e 全天 刚好两天', a, { date: day(-2), remind_days: 0, remind_at: n - DAY }),
    ev('e 全天 过三天 稍后在窗口内', a, { date: day(-3), remind_days: 0, remind_at: n - 3 * DAY, snooze_at: n - 30 * MIN }),
    ev('e 全天 过三天 稍后在窗口外', a, { date: day(-3), remind_days: 0, remind_at: n - 3 * DAY, snooze_at: n - 61 * MIN }),
    ev('e 全天 过三天 顺延在窗口内', a, { date: day(-3), remind_days: 0, remind_at: n - 3 * DAY, defer_until: n - 10 * MIN }),
    ev('e 全天 过三天 顺延刚好 1 小时', a, { date: day(-3), remind_days: 0, remind_at: n - 3 * DAY, defer_until: n - 60 * MIN }),
    ev('e 全天 没设提醒 没到点', a, { date: day(1), remind_days: null, remind_at: n + 1000 }),
    ev('e 全天 没设提醒 没算', a, { date: day(1), remind_days: null }),
    ev('e 全天 刚好到点', a, { date: day(0), remind_days: 0, remind_at: n }),
    ev('e 全天 差 1 毫秒到点', a, { date: day(0), remind_days: 0, remind_at: n + 1 }),
    ev('e 全天 刚好 24 小时', a, { date: day(1), remind_days: 0, remind_at: n + DAY }),
    ev('e 全天 24 小时多 1 毫秒', a, { date: day(2), remind_days: 1, remind_at: n + DAY + 1 }),
    ev('e 全天 五天后', a, { date: day(5), remind_days: 1, remind_at: n + 4 * DAY }),
    ev('e 全天 删了', a, { date: day(1), remind_days: 0, deleted_at: 5 }),
    ev('e 有时刻 设了提醒', a, { ...timed, date: day(1), remind_min: 15, remind_at: n + 2 * DAY }),
    ev('e 有时刻 没设提醒', a, { ...timed, date: day(1), remind_min: null }),
    ev('e 有时刻 过三天 稍后在窗口内', a, { ...timed, date: day(-3), remind_min: 0, remind_at: n - 3 * DAY, snooze_at: n - 5 * MIN }),
    ev('e 有时刻 刚好两天', a, { ...timed, date: day(-2), remind_min: 60, remind_at: n - 2 * DAY }),
    ev('e 别人的 全天', b, { date: day(0), remind_days: 0 }),
    ev('e 别人的 有时刻', b, { ...timed, date: day(1), remind_min: 30, remind_at: n + 3 * DAY }),
    // ---- 待办 ----
    td('t 全天 过三天 没算', a, { due: day(-3), remind_days: 0 }),
    td('t 全天 刚好两天', a, { due: day(-2), remind_days: 0, remind_at: n - 2 * DAY }),
    td('t 全天 过三天 稍后在窗口内', a, { due: day(-3), remind_days: 0, remind_at: n - 3 * DAY, snooze_at: n - 59 * MIN }),
    td('t 全天 过三天 顺延在窗口内', a, { due: day(-3), remind_days: 0, remind_at: n - 3 * DAY, defer_until: n - 1 * MIN }),
    td('t 全天 过三天 顺延在窗口外', a, { due: day(-3), remind_days: 0, remind_at: n - 3 * DAY, defer_until: n - 61 * MIN }),
    td('t 有截止时刻 有提前量', a, { due: day(1), due_time: '10:00', remind_before_min: 30 }),
    td('t 有截止时刻 没提前量', a, { due: day(1), due_time: '10:00', remind_before_min: null, remind_days: 0 }),
    td('t 全天 没设提醒', a, { due: day(1), remind_days: null }),
    td('t 截止为空 没到点', a, { due: null, remind_at: n + 60 * MIN }),
    td('t 截止为空 没算', a, { due: null }),
    td('t 刚好到点', a, { due: day(0), remind_days: 0, remind_at: n }),
    td('t 刚好 24 小时', a, { due: day(1), remind_days: 0, remind_at: n + DAY }),
    td('t 24 小时多 1 毫秒', a, { due: day(2), remind_days: 1, remind_at: n + DAY + 1 }),
    td('t 完成了', a, { due: day(1), remind_days: 0, done: true }),
    td('t 删了', a, { due: day(1), remind_days: 0, deleted_at: 5 }),
    td('t 别人的', b, { due: day(1), remind_days: 0 }),
    // ---- 纪念日 ----
    an('a 默认 没算', a, {}),
    an('a 自定义 过了', a, { remind_offsets: [1], remind_time: '09:00', remind_at: n - 1 }),
    an('a 自定义 没到点', a, { remind_offsets: [1, 7], remind_time: '20:00', remind_at: n + 10 * DAY }),
    an('a 只自定义偏移 没到点', a, { remind_offsets: [0], remind_time: null, remind_at: n + 2 * DAY }),
    an('a 只自定义时刻 刚好到点', a, { remind_offsets: null, remind_time: '08:00', remind_at: n }),
    an('a 默认 刚好 24 小时', a, { remind_at: n + DAY }),
    an('a 删了', a, { deleted_at: 5 }),
    an('a 别人的', b, {}),
  ];
}

/** 照 ItemRow 写进真库（只写这几支会看的列和必填列）；值和替身里的那一份完全相同 */
async function insert(tx: typeof sql, c: Case): Promise<void> {
  const r = c.row as ItemRow & Record<string, unknown>;
  const common = { id: r.id, user_id: r.user_id, deleted_at: r.deleted_at, remind_at: r.remind_at, snooze_at: r.snooze_at, defer_until: r.defer_until };
  if (c.table === 'events') {
    await tx`insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, deleted_at, remind_at, snooze_at, defer_until, created_at, updated_at)
      values (${common.id}, ${common.user_id}, 'parity', ${r.date as string}::date, ${(r.time as string | null) ?? null}, ${(r.tz as string | null) ?? null},
              ${(r.remind_min as number | null) ?? null}, ${(r.remind_days as number | null) ?? null}, ${common.deleted_at}, ${common.remind_at},
              ${common.snooze_at}, ${common.defer_until}, 1, 1)`;
  } else if (c.table === 'todos') {
    await tx`insert into public.todos (id, user_id, title, due, due_time, remind_before_min, remind_days, remind_time, done, deleted_at, remind_at, snooze_at, defer_until, created_at, updated_at)
      values (${common.id}, ${common.user_id}, 'parity', ${(r.due as string | null) ?? null}::date, ${(r.due_time as string | null) ?? null},
              ${(r.remind_before_min as number | null) ?? null}, ${(r.remind_days as number | null) ?? null}, ${r.remind_time as string}, ${r.done as boolean},
              ${common.deleted_at}, ${common.remind_at}, ${common.snooze_at}, ${common.defer_until}, 1, 1)`;
  } else {
    const offs = r.remind_offsets as number[] | null;
    await tx`insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, remind_offsets, remind_time, deleted_at, remind_at, snooze_at, defer_until, created_at, updated_at)
      values (${common.id}, ${common.user_id}, ${r.kind as string}, 'parity', ${r.calendar as string}, ${r.month as number}, ${r.day as number},
              ${offs === null ? null : `{${offs.join(',')}}`}::smallint[], ${(r.remind_time as string | null) ?? null}, ${common.deleted_at}, ${common.remind_at},
              ${common.snooze_at}, ${common.defer_until}, 1, 1)`;
  }
}

class Rollback extends Error {}

Deno.test({ name: 'remind-enqueue-parity 开跑：清掉上次留下的', ...opts, async fn() {
  await healLeftovers();
} });

Deno.test({ name: 'R-411 批量入队 SQL 和替身同口径：floating、allday、anniv、all 四支，同一批边界行，入队的（表、id、prio）一模一样', ...opts, async fn() {
  const a = await mkUser('parity-a');
  const b = await mkUser('parity-b');
  const scopes: { scope: EnqueueScope; user: string | null }[] = [
    { scope: 'floating', user: a }, { scope: 'allday', user: a }, { scope: 'anniv', user: a }, { scope: 'all', user: null },
  ];
  const diffs: string[] = [];
  const counts: string[] = [];
  try {
    await sql.begin(async (tx) => {
      const n = Number((await tx<{ ms: string }[]>`select ((extract(epoch from now()) * 1000)::bigint)::text as ms`)[0]?.ms);
      const all = cases(n, a, b);
      for (const c of all) await insert(tx as unknown as typeof sql, c);
      const ids = all.map((c) => c.row.id);
      const nameOf = new Map(all.map((c) => [`${c.table}:${c.row.id}`, c.name]));
      for (const { scope, user } of scopes) {
        await tx`delete from private.remind_queue where id = any(${ids}::uuid[])`;   // 新建时 after 触发器按 row 入队的，和上一支留下的
        await tx`select private.remind_enqueue(${scope}, ${user}::uuid, null, null, false, 0::smallint)`;
        const got = (await tx<{ k: string }[]>`select table_name || ':' || id || ':' || prio as k from private.remind_queue where id = any(${ids}::uuid[])`)
          .map((x) => x.k).sort();
        const mem = new MemDb();
        mem.clock = () => n;
        for (const c of all) mem.put(c.table, { ...c.row });
        mem.enqueueScope(scope, user);
        const want = [...mem.queue.values()].map((q) => `${q.table_name}:${q.id}:${q.prio ?? 0}`).sort();
        const label = (k: string) => { const [t, i, p] = k.split(':'); return `${nameOf.get(`${t}:${i}`) ?? k}（prio ${p}）`; };
        const onlySql = got.filter((k) => !want.includes(k)).map(label);
        const onlyMem = want.filter((k) => !got.includes(k)).map(label);
        counts.push(`${scope} ${got.length}`);
        if (onlySql.length || onlyMem.length) diffs.push(`${scope}：只在 SQL 里 [${onlySql.join('；')}]，只在替身里 [${onlyMem.join('；')}]`);
      }
      throw new Rollback();   // 全部回滚：造的行、入队项（含 all 一支入队的别人的行）都不留
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(`[R411-parity] ${cases(0, a, b).length} 行，入队条数 ${counts.join('、')}；${diffs.length ? `不一致 ${diffs.length} 支` : '两边一致'}`);
  assertEquals(diffs, [], 'remind_enqueue 和 MemDb.enqueueScope 的批量范围不一致');
  assertEquals((await sql`select 1 from public.events where user_id = any(${[a, b]}::uuid[])`).length, 0, '回滚后不该留下造的行');
} });

Deno.test({ name: 'remind-enqueue-parity 收尾：删掉这次建的用户、放锁、关连接', ...opts, async fn() {
  try {
    await purgeTraces(ours);
    await writeLedger([]);
  } finally {
    await releaseLock();
    await sql.end({ timeout: 5 });
  }
} });
