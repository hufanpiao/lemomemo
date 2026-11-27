// R-350 评审第 2 条（11-13 主持人代定：子任务上限要锁主待办行）：两个连接同时往同一条待办下加子任务，30 项上限守得住。
// 迁移 20261113170000 的 private.todo_items_cap() 先对主待办行拿 for no key update 锁再数：同一条待办下的插入排队，后一个等前一个提交后再数。
// 不锁的话两个连接各自只看得到 29 项，都能插进去，变成 31 项（29+N）。
// 做法：待办 T 先放 29 项（已提交）；连接 1 开事务插第 30 项、先不提交；连接 2 再插一项，应当卡在锁上（pg_stat_activity 里等 Lock）；
// 连接 1 提交后连接 2 报 items_quota；最后 T 下正好 30 项。对照：另一条待办 T2 上两个连接同时插各一项，不互相挡（锁只在同一条待办内）。
// 以 postgres 身份直接写（触发器照样跑；RLS 的口径由 pgTAP 50_todo_items 管）。
// 跑法：由 supabase/tests/store-it/run.mjs 起（单独一个 deno 进程：收尾会关库连接）。本机 npm run e2e:real:up →
//   node supabase/tests/store-it/run.mjs --e2e-sb → npm run e2e:real:down。
import { assert, assertEquals, healLeftovers, mkUser, ours, purgeTraces, releaseLock, sleep, sql, writeLedger } from './harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };

/** 往待办 todo 下插一项子任务（tx 可以是事务里的连接） */
const addItem = (tx: typeof sql, user: string, todo: string, title: string) =>
  tx`insert into public.todo_items (id, user_id, todo_id, title, sort, created_at, updated_at)
     values (${crypto.randomUUID()}, ${user}, ${todo}, ${title}, 1, 1, 1)`;

/** 有没有一个后端正卡在锁上、跑的是往 todo_items 插入（postgres.js 走参数化查询，SQL 文本里看不到标题，按表名认；本测试独占这张表的写入） */
const waitingOnInsert = async () =>
  (await sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'insert into public.todo_items%'`).length > 0;

Deno.test({ name: 'todo-items-cap 开跑：清掉上次留下的', ...opts, async fn() {
  await healLeftovers();
} });

Deno.test({ name: 'R-350 子任务上限：两个连接同时往同一条待办加，第二个排队等第一个提交，然后报 items_quota，最后正好 30 项', ...opts, async fn() {
  const a = await mkUser('items-cap');
  const t = crypto.randomUUID();
  const t2 = crypto.randomUUID();
  await sql`insert into public.todos (id, user_id, title, created_at, updated_at) values (${t}, ${a}, 'T', 1, 1), (${t2}, ${a}, 'T2', 1, 1)`;
  for (let i = 1; i <= 29; i++) await addItem(sql, a, t, `已有${i}`);

  let release: () => void = () => {};
  const hold = new Promise<void>((ok) => { release = ok; });
  let firstIn: () => void = () => {};
  const firstInserted = new Promise<void>((ok) => { firstIn = ok; });
  const first = sql.begin(async (tx) => {
    await addItem(tx as unknown as typeof sql, a, t, '连接1第30项');
    firstIn();
    await hold;   // 拿着主待办的锁不提交
  });
  await firstInserted;
  let secondDone = false;
  const second = sql.begin(async (tx) => {
    await addItem(tx as unknown as typeof sql, a, t, '连接2第31项');
  }).then(() => 'ok', (e: { message?: string }) => e.message ?? String(e)).finally(() => { secondDone = true; });

  try {
    let blocked = false;
    for (let i = 0; i < 50 && !blocked; i++) {   // 最多等 5 秒看到它卡在锁上
      blocked = await waitingOnInsert();
      if (!blocked) await sleep(100);
    }
    assert(blocked, '连接 2 应当卡在主待办行的锁上（pg_stat_activity 里没看到它在等 Lock）');
    assert(!secondDone, '连接 1 没提交之前，连接 2 不该已经结束');

    // 对照：另一条待办 T2 上的插入不受 T 的锁影响，马上就能做完
    await addItem(sql, a, t2, 'T2 的一项');

    release();
    await first;
    assertEquals(await second, 'items_quota', '连接 1 提交后，连接 2 数到 30 项，报 items_quota');
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from public.todo_items where todo_id = ${t}`)[0]?.n;
    assertEquals(n, 30, 'T 下正好 30 项（不锁的话会是 31）');
    console.log(`[R350-cap] 连接 2 等锁 ${blocked ? '看到了' : '没看到'}，结果 items_quota，T 下 ${n} 项`);
  } finally {
    release();   // 断言失败时也放开连接 1，免得事务挂着、收尾关不掉连接
    await first.catch(() => undefined);
    await second;
  }
} });

Deno.test({ name: 'todo-items-cap 收尾：删掉这次建的用户、放锁、关连接', ...opts, async fn() {
  try {
    await purgeTraces(ours);
    await writeLedger([]);
  } finally {
    await releaseLock();
    await sql.end({ timeout: 5 });
  }
} });
