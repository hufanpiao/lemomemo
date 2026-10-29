// K3-store-it（B1 接手清单，K3 安全审查）：account、account-purge 两个 index.ts 里接 PostgREST / Storage / R2 的真 store，
// 打本机真库（supabase start）。入口 supabase/tests/store-it/run.mjs（npm run test:db 的最后一段）。
// 不改源码：先把 Deno.serve 换成“只记下处理函数”，再 import 两个 index.ts，拿到它们的真处理函数直接喂 Request——
// store、supabase-js、Storage、objstore 客户端都是线上同一份代码，只换掉三样外部的东西：
//   • Resend：拦 fetch('https://api.resend.com/…')，记下收件人、回 200（不真发信）；
//   • R2：仓库已有的 S3 替身 tests/shared/fake-s3.ts（自己验 SigV4、核 Content-MD5），挂在 127.0.0.1 随机端口，
//     pageSize = 2，删前缀时真的走 ListObjectsV2 翻页；
//   • 登录：admin 接口建用户（不设密码）→ generateLink 取 magiclink 的 token_hash → verifyOtp 换真 JWT（不发信、不占发信额度）。
// 覆盖接手清单 ①～⑤：
//   ① PostgREST 的 or 过滤串在真库筛出的行对：没认领、认领超过 1 小时的删，认领 10 分钟的、没到期的不动；
//   ② readPage 按主键往后翻页：2500 行（跨三页）、正好 2000 行（两整页）、数字主键的 logs，都不漏不重、顺序和库里一致；
//   ③ deleted_accounts 的 upsert ignoreDuplicates 不覆盖已有行；
//   ④ deleteUser 以后 profiles、pending_deletions 为 0 行，函数判 purged；导出的 makeStore 直接测 remainingRows（没删的 2、随机 uuid 0）；
//   ⑤ TC-B1-108 ② 竞态：两个真连接——一个事务里 account_restore 持 for update 锁，认领 update 经 PostgREST 等锁（pg_blocking_pids 为证），
//      restore 提交后认领更新 0 行。
// 另外：refundRate 在真 counters 上比较并交换（含每天 3 次的退回上限）、requestDeletion 的报错映射、经 account 处理函数申请注销再恢复。
// 安全：本机库是共用的，account-purge 会处理库里所有到期的 pending_deletions。
//   • 开跑先清上次残留（被 kill 时）：supabase/.temp/store-it-ids.json 记的 id 和 auth.users 里 k3-store-it-*@example.com 的人，
//     删用户、deleted_accounts 行、counters 键、backups 路径，再 drop 本测试的临时 schema store_it；
//   • 每次调 account-purge 前查别人的到期行（49 小时内到期的也算，会收提醒信），有就失败、不调用；
//   • 跑完照样清理。
import {
  assert, one, assertEquals, sleep, EMAIL_LIKE, BACKUP_DATE, START, mails, fakeS3, s3Server, s3Put, s3Has, purgeMod, sql, admin, ours, emails, writeLedger, purgeTraces, healLeftovers, mkUser, pending, runPurge, callAccount, userExists, today, counter, jwtOf, releaseLock,
} from './harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({ name: 'store-it 开跑：清掉上次（被 kill 时）留下的用户、行、备份和临时 schema', ...opts, async fn() {
  await healLeftovers();
  assertEquals((await sql`select 1 from auth.users where email like ${EMAIL_LIKE}`).length, 0);
} });

Deno.test({ name: '①③④ account-purge 真 store：or 过滤选对人；R2（翻页）、backups、counters、deleted_accounts、deleteUser 和核对', ...opts, async fn() {
  const u1 = await mkUser('due');          // 到期、没认领 → 删
  const u2 = await mkUser('stale');        // 到期、2 小时前认领（进程崩了）→ 重领后删
  const u3 = await mkUser('claimed');      // 到期、10 分钟前认领（另一次正在做）→ 不动
  const u4 = await mkUser('notdue');       // 3 天后到期 → 不动
  await pending(u1, -3600);
  await pending(u2, -3600, 7200);
  await pending(u3, -3600, 600);
  await pending(u4, 3 * 86400);
  const { c3 } = one(await sql<{ c3: string }[]>`select purge_started_at::text as c3 from private.pending_deletions where user_id = ${u3}`);
  // ③ 预先放一行 deleted_accounts（模拟上一次写了、没删完），跑完不能被覆盖。
  //   怎么区分“没覆盖”和“覆盖了”：service_role 对 deleted_accounts 只有 select、insert（0001 第 18 节），没有 update。
  //   ignoreDuplicates 是 on conflict do nothing，不需要 update；要是写成合并（do update），PostgREST 会因没有 update 权限报错，
  //   函数判 failed——所以 purged === 2 加上“还是 2000-01-01、早于本次开跑”两条一起成立，才说明真是 do nothing。
  await sql`insert into private.deleted_accounts (user_id, deleted_at) values (${u1}, '2000-01-01T00:00:00Z')`;
  // 库外数据：每人几个对象，pageSize = 2 时要翻页
  for (const k of ['a.webp', 'b.webp', 'c.webp']) s3Put('images', `${u1}/${k}`);
  for (const k of ['a.pdf', 'b.pdf', 'c.pdf']) s3Put('files', `${u2}/${k}`);
  s3Put('vault-files', `${u2}/d.bin`);
  s3Put('images', `${u3}/x.webp`); s3Put('files', `${u4}/y.pdf`);
  const gz = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const u of [u1, u3]) {
    const up = await admin.storage.from('backups').upload(`${BACKUP_DATE}/${u}/notes.json.gz`, gz, { contentType: 'application/gzip', upsert: true });
    assert(!up.error, `备份上传失败：${up.error?.message}`);
  }
  await sql`insert into private.counters (key, window_start, count) values
    (${`account:${u1}:20261029`}, now(), 1), (${`account:${u3}:20261029`}, now(), 1)`;
  const listsBefore = fakeS3.calls.filter((c) => c.method === 'GET').length;

  try {
    const before = mails.length;
    const body = await runPurge();
    assertEquals([body.purged, body.failed], [2, 0], JSON.stringify(body));
    // ① or 过滤：u1、u2 删了，u3、u4 留着；u3 的认领时刻没被改
    assertEquals([await userExists(u1), await userExists(u2), await userExists(u3), await userExists(u4)], [false, false, true, true]);
    const { c3after } = one(await sql<{ c3after: string }[]>`select purge_started_at::text as c3after from private.pending_deletions where user_id = ${u3}`);
    assertEquals(c3after, c3);
    assertEquals((await sql`select 1 from private.pending_deletions where user_id = ${u4} and purge_started_at is null`).length, 1);
    // ③ ignoreDuplicates：u1 那一行还是 2000-01-01（早于本次开跑）；u2 新写了一行（晚于开跑）
    const d1 = one(await sql<{ d: Date }[]>`select deleted_at as d from private.deleted_accounts where user_id = ${u1}`).d;
    assert(d1.getTime() < START.getTime() && d1.toISOString() === '2000-01-01T00:00:00.000Z', `u1 的 deleted_accounts 被覆盖了：${d1.toISOString()}`);
    const d2 = one(await sql<{ d: Date }[]>`select deleted_at as d from private.deleted_accounts where user_id = ${u2}`).d;
    assert(d2.getTime() >= START.getTime() - 60_000, 'u2 的 deleted_accounts 不是这次写的');
    // ④ 两人在 profiles、pending_deletions 都是 0 行（remainingRows 返回 0，函数才判 purged）；没删的两人共 4 行
    const { n } = one(await sql<{ n: number }[]>`select ((select count(*) from public.profiles where user_id in (${u1}, ${u2}))
      + (select count(*) from private.pending_deletions where user_id in (${u1}, ${u2})))::int as n`);
    assertEquals(n, 0);
    const { m } = one(await sql<{ m: number }[]>`select ((select count(*) from public.profiles where user_id in (${u3}, ${u4}))
      + (select count(*) from private.pending_deletions where user_id in (${u3}, ${u4})))::int as m`);
    assertEquals(m, 4);
    const store = purgeMod.makeStore(admin);
    assertEquals([await store.remainingRows(u1), await store.remainingRows(u3), await store.remainingRows(crypto.randomUUID())], [0, 2, 0]);
    // R2：u1、u2 的前缀删光（真的翻了页），u3、u4 的不动
    assertEquals(['a', 'b', 'c'].map((k) => s3Has('images', `${u1}/${k}.webp`)), [false, false, false]);
    assertEquals([...['a', 'b', 'c'].map((k) => s3Has('files', `${u2}/${k}.pdf`)), s3Has('vault-files', `${u2}/d.bin`)], [false, false, false, false]);
    assertEquals([s3Has('images', `${u3}/x.webp`), s3Has('files', `${u4}/y.pdf`)], [true, true]);
    const paged = fakeS3.calls.slice(listsBefore).filter((c) => c.method === 'GET' && c.query.includes('continuation-token'));
    assert(paged.length >= 1, '删 R2 没有走翻页（pageSize = 2）');
    // backups：u1 的删了，u3 的还在
    const l1 = (await admin.storage.from('backups').list(`${BACKUP_DATE}/${u1}`)).data ?? [];
    const l3 = (await admin.storage.from('backups').list(`${BACKUP_DATE}/${u3}`)).data ?? [];
    assertEquals([l1.length, l3.length], [0, 1]);
    // counters：u1 的键删了，u3 的还在
    const ck = await sql<{ key: string }[]>`select key from private.counters where key in (${`account:${u1}:20261029`}, ${`account:${u3}:20261029`})`;
    assertEquals(ck.map((r) => r.key), [`account:${u3}:20261029`]);
    // 最后一封信发给 u1、u2
    const sent = mails.slice(before);
    assert(sent.includes(emails.get(u1) ?? '?') && sent.includes(emails.get(u2) ?? '?'), `没给删掉的两人发最后一封信：${sent.length} 封`);
  } finally {
    await sql`delete from private.pending_deletions where user_id in (${u3}, ${u4})`;   // 别留着让下一次调用或别人的测试碰到
  }
} });

Deno.test({ name: '② account export 真 store：readPage 按主键往后翻页——2500 行、正好 2000 行、数字主键的 logs，都不漏不重', ...opts, async fn() {
  const e = await mkUser('export');
  const other = await mkUser('other');
  await sql`insert into public.todos (id, user_id, title, created_at, updated_at)
    select gen_random_uuid(), ${e}, 't' || g, 1, 1 from generate_series(1, 2500) g`;
  await sql`insert into public.todos (id, user_id, title, created_at, updated_at) values (gen_random_uuid(), ${other}, 'not-mine', 1, 1)`;
  await sql`insert into public.settings (id, user_id, key, value) select gen_random_uuid(), ${e}, 'k' || g, '1'::jsonb from generate_series(1, 2000) g`;
  await sql`insert into public.logs (user_id, t, kind, act, src) select ${e}, g, 'run', 'x', 'store-it' from generate_series(1, 2300) g`;
  // 期望顺序按列本身的类型排（和 readPage 的 gt、order 一致）：输出列别名不能叫 id——
  //   Postgres 的 order by 裸名字先认输出列，`select id::text … order by id` 会按文本排（logs 的 1、10、100 排在 2 前面）
  const ids = async (table: 'todos' | 'settings') =>
    (await sql<{ k: string }[]>`select id::text as k from ${sql(table)} where user_id = ${e} order by id`).map((r) => r.k);
  const wantTodos = await ids('todos');
  const wantSettings = await ids('settings');
  const r = await callAccount(await jwtOf(e), { action: 'export' });
  assertEquals(r.status, 200, JSON.stringify(r.json));
  const doc = JSON.parse(await new Response(r.res.body?.pipeThrough(new DecompressionStream('gzip'))).text()) as {
    tables: Record<string, { id: string | number; user_id: string }[]>;
  };
  const got = (t: string) => (doc.tables[t] ?? []).map((x) => x.id);
  assertEquals(got('todos').length, 2500);
  assertEquals(got('todos'), wantTodos, 'todos（跨三页）顺序或内容不对');
  assertEquals(got('settings').length, 2000);
  assertEquals(got('settings'), wantSettings, 'settings（正好两整页）顺序或内容不对');
  // 导出通知（第 96 条依赖的安全手段）真发出去了：响应之后后台发信，轮询 Resend 替身收到 e 的邮箱（最多 5 秒），
  //   且没有 export_mail_failed（发信失败才写那一条）
  const mailTo = emails.get(e) ?? '?';
  for (let i = 0; i < 50 && !mails.includes(mailTo); i++) await sleep(100);
  assert(mails.includes(mailTo), '5 秒内没有给导出的人发通知信');
  await sleep(200);   // 让后台那段跑完（发信成功就不写日志）
  assertEquals((await sql`select 1 from public.logs where user_id = ${e} and act = 'export_mail_failed'`).length, 0, '导出通知发信失败');
  // logs：bigserial 主键，PostgREST 回数字；2300 条加导出前先写的那一条（act = export）
  const wantLogs = (await sql<{ k: string }[]>`select id::text as k from public.logs where user_id = ${e} order by id`).map((x) => Number(x.k));
  // 防退化：期望和导出都必须按数字严格递增（游标 gt 按 bigint 比，排序也得按 bigint；按文本排会在 9→10 这类位数变化处漏行或重复）
  const ascending = (a: unknown[]) => a.every((x, i) => i === 0 || (a[i - 1] as number) < (x as number));
  assert(ascending(wantLogs), 'logs 期望顺序不是按数字升序（别名又叫 id 了？）');
  assert(ascending(got('logs')), 'logs 导出顺序不是按数字升序');
  assertEquals(got('logs').length, wantLogs.length);
  assertEquals(got('logs'), wantLogs, 'logs（数字主键）顺序或内容不对');
  assert(got('logs').every((x) => typeof x === 'number'), 'logs 的 id 不是数字');
  assert(Object.values(doc.tables).flat().every((x) => x.user_id === e), '包里有别人的行');
} });

Deno.test({ name: '⑤ TC-B1-108 ② 真库竞态：restore 持 for update 锁，认领 update 等锁，restore 提交后认领 0 行', ...opts, async fn() {
  const r = await mkUser('race');
  await pending(r, 2);   // 2 秒后到期
  const conn = await sql.reserve();
  let committed = false;
  let purgeP: Promise<unknown> | null = null;
  try {
    await conn`begin`;
    const { pid } = one(await conn<{ pid: number }[]>`select pg_backend_pid() as pid, now()`);   // 事务时刻定在到期前
    await sleep(3000);   // 墙钟过了 purge_after：account-purge 认为它到期了；事务里的 now() 还是到期前
    const { res } = one(await conn<{ res: string }[]>`select private.account_restore(${r}::uuid) as res`);
    assertEquals(res, 'ok');   // pending_deletions 那一行已删、未提交，锁着
    let settled = false;
    const p = runPurge().finally(() => { settled = true; });
    purgeP = p;
    // 等锁的证据：有一个被持锁连接挡住、语句里有 pending_deletions 的会话（带超时轮询）
    let blocked = 0;
    for (let i = 0; i < 100 && blocked === 0; i++) {
      blocked = one(await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
        where ${pid}::int = any(pg_blocking_pids(pid)) and query ilike '%pending_deletions%'`).n;
      if (blocked === 0) await sleep(100);
    }
    assert(blocked >= 1, '10 秒内没看到被 restore 的锁挡住的认领 update');
    assert(!settled, 'account-purge 没等 restore 的锁就返回了');
    await conn`commit`;
    committed = true;
    const body = await p;
    assertEquals([body.purged, body.failed, body.skipped], [0, 0, 1], JSON.stringify(body));
    assert(await userExists(r), '恢复了的账号被删了');
    const prof = one(await sql<{ disabled_at: string | null }[]>`select disabled_at from public.profiles where user_id = ${r}`);
    assertEquals(prof.disabled_at, null);
    assertEquals((await sql`select 1 from private.pending_deletions where user_id = ${r}`).length, 0);
    assertEquals((await sql`select 1 from private.deleted_accounts where user_id = ${r}`).length, 0);
  } finally {
    if (!committed) await conn`rollback`.catch(() => {});
    conn.release();
    await purgeP?.catch(() => {});   // commit 前就失败时，别让 account-purge 在后台接着跑、和后面的测试交错
  }
} });

Deno.test({ name: 'account 真 store：申请注销（requestDeletion）→ 恢复（restore）走一遍；报错映射（admin_cannot_delete → 403）', ...opts, async fn() {
  const d = await mkUser('delrestore');
  const r1 = await callAccount(await jwtOf(d), { action: 'delete', confirm: '注销' });
  assertEquals(r1.status, 200, JSON.stringify(r1.json));
  const p = one(await sql<{ reason: string; pa: Date }[]>`select p.disabled_reason as reason, d.purge_after as pa
    from public.profiles p join private.pending_deletions d using (user_id) where p.user_id = ${d}`);
  assertEquals(p.reason, 'deletion');
  assertEquals(new Date(String(r1.json?.purge_after)).getTime(), p.pa.getTime());
  assertEquals((await sql`select 1 from auth.sessions where user_id = ${d}`).length, 0);   // 全部会话吊销
  // 重新登录（magiclink 的 amr 是 otp，10 分钟内）再恢复
  const jwt = await jwtOf(d);
  const amr = (JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { amr?: { method?: string }[] }).amr;
  assert(amr?.some((x) => x.method === 'otp'), `magiclink 登录的 amr 里没有 otp：${JSON.stringify(amr)}`);
  const r2 = await callAccount(jwt, { action: 'restore' });
  assertEquals([r2.status, r2.json], [200, { ok: true }]);
  assertEquals((await sql`select 1 from private.pending_deletions where user_id = ${d}`).length, 0);
  assertEquals(one(await sql<{ x: string | null }[]>`select disabled_at as x from public.profiles where user_id = ${d}`).x, null);

  // requestDeletion 的报错映射：rpc 抛的业务码 PostgREST 原样放在 message 里，index.ts 按 RPC_CODES 认出来、回 403。
  //   没有 profile 的人（account_disabled）见下一条 TC-B1-10。
  const adm = await mkUser('admin');
  await sql`insert into private.admins (user_id) values (${adm})`;
  const ea = await admin.schema('private').rpc('account_request_deletion', { p_user: adm });
  assertEquals(ea.error?.message, 'admin_cannot_delete');
  const ra = await callAccount(await jwtOf(adm), { action: 'delete', confirm: '注销' });
  assertEquals([ra.status, ra.json], [403, { error: 'admin_cannot_delete' }]);
} });

Deno.test({ name: 'TC-B1-10：没有 profiles 行的账号调 account delete 回 403 account_disabled', ...opts, async fn() {
  //   没有 profile 的人：入口 requireActiveUser 先拦（account_usable 为 false、也不在冷静期）→ 403 account_disabled；
  //   rpc 自己那一道 account_disabled 碰不到（入口先拦），所以用 service role 直接调 rpc 核对消息就是码本身。
  const np = await mkUser('noprofile', false);
  const { error } = await admin.schema('private').rpc('account_request_deletion', { p_user: np });
  assertEquals(error?.message, 'account_disabled', 'rpc 的业务错误消息不是码本身，index.ts 的 RPC_CODES 认不出');
  const rn = await callAccount(await jwtOf(np), { action: 'delete', confirm: '注销' });
  assertEquals([rn.status, rn.json], [403, { error: 'account_disabled' }]);
} });

Deno.test({ name: 'account 真 store：refundRate 在真 counters 上比较并交换退回；每天退回 3 次以后照常扣', ...opts, async fn() {
  const f = await mkUser('refund');
  // 让这个人的 logs 写不进（临时 schema 里的触发器，只拦这一个 user_id；开跑和收尾都 drop）→ export_log_failed → 退回
  await sql.unsafe(`create schema store_it;
    create function store_it.fail_logs() returns trigger language plpgsql as $f$
      begin if new.user_id = '${f}'::uuid then raise exception 'store_it_blocked'; end if; return new; end $f$;
    create trigger store_it_fail before insert on public.logs for each row execute function store_it.fail_logs();`);
  try {
    const jwt = await jwtOf(f);
    const acc = `account:${f}:${today()}`, ref = `export-refund:${f}:${today()}`;
    for (let i = 1; i <= 3; i++) {
      const r = await callAccount(jwt, { action: 'export' });
      assertEquals([r.status, r.json], [503, { error: 'try_later' }]);
      assertEquals([await counter(acc), await counter(ref)], [0, i], `第 ${i} 次：导出计数没退回到 0`);
    }
    const r4 = await callAccount(jwt, { action: 'export' });
    assertEquals(r4.status, 503);
    assertEquals([await counter(acc), await counter(ref)], [1, 4], '第 4 次应该照常扣');
  } finally {
    await sql`drop schema if exists store_it cascade`;
  }
} });

Deno.test({ name: 'store-it 收尾：删掉本次建的用户和留下的行', ...opts, async fn() {
  try {
    await purgeTraces(ours);
    await writeLedger([]);
    assertEquals((await sql`select 1 from auth.users where email like ${EMAIL_LIKE}`).length, 0);
  } finally {
    await releaseLock();
    await sql.end({ timeout: 5 });
    await s3Server.shutdown();
  }
} });

