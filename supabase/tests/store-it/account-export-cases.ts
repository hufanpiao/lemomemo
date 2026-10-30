// K3-store-it 的 account export 一组（架构 0.47 续 ①两步协议；安全代码审查条件 C1）：真 store 打本机真库。
// 由 account-store.it.ts 在“开跑”清残留之后调用 registerExportTests() 注册（直接 import 会让这些用例排到清残留前面）。
// 覆盖：
//   • start → part → done 完整走一遍：readPage 按主键往后翻页（2500 行跨多页、正好 2000 行、数字主键的 logs），各片拼起来行数和顺序对；
//     四个计数（account、export-size、export-part、任务行 count）和 logs 两条（export、export_done，code 相同、fields 对得上）；
//   • 真 rpc 的返回形状：export_job_take 回表（verdict、started_at、parts）、带微秒的 timestamptz 能被 Date.parse、
//     export_size_over 和 db_size_bytes 的 bigint 回成数字；
//   • 另一条 postgres 连接先拿住预检的 advisory 锁（7310310001）再调 start：try_later，export-size 计数退回、不扣导出次数，日志 export_size_busy；
//   • 冷静期账号的 start、part 都被 requireActiveUser 拦下（account_pending_deletion），也不扣 export-size。
import { assert, assertEquals, callAccount, counter, emails, jwtOf, mails, mkUser, one, sleep, sql, today, admin } from './harness.ts';

type Opts = { sanitizeOps: boolean; sanitizeResources: boolean };
const SIZE_LOCK = 7310310001;   // 和迁移 20261031100000 的 export_size_over 一致

/** 调 start，回 export_id 和 exported_at */
async function startExport(jwt: string): Promise<{ id: string; at: string }> {
  const r = await callAccount(jwt, { action: 'export', step: 'start' });
  assertEquals(r.status, 200, JSON.stringify(r.json));
  const keys = Object.keys(r.json ?? {}).sort();
  assertEquals(keys, ['export_id', 'exported_at', 'ok'], 'start 回包只能有 ok、export_id、exported_at');
  return { id: String(r.json?.export_id), at: String(r.json?.exported_at) };
}

/** 一片一片取到 done，各片单独解开后原文拼起来 */
async function fetchAll(jwt: string, id: string): Promise<{ doc: { tables: Record<string, { id: string | number; user_id: string }[]> } & Record<string, unknown>; parts: number; bytes: number }> {
  let cursor: string | null = null;
  let raw = '';
  let parts = 0;
  let bytes = 0;
  for (let i = 0; i < 50; i++) {
    const r = await callAccount(jwt, { action: 'export', step: 'part', export_id: id, cursor });
    assertEquals(r.status, 200, JSON.stringify(r.json));
    assertEquals(r.res.headers.get('content-encoding'), null);
    const b = new Uint8Array(await r.res.arrayBuffer());
    parts += 1;
    bytes += b.byteLength;
    raw += await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const next = r.res.headers.get('x-lemo-export-next') ?? '';
    assert(next.length > 0 && next.length <= 512, `游标头不对：${next.length}`);
    if (next === 'done') return { doc: JSON.parse(raw), parts, bytes };
    cursor = next;
  }
  throw new Error('50 片还没取完');
}

export function registerExportTests(opts: Opts): void {
  Deno.test({ name: '② account export 真 store 两步：start → part → done；翻页不漏不重；四个计数和 logs 两条对得上', ...opts, async fn() {
    const e = await mkUser('export');
    const other = await mkUser('other');
    await sql`insert into public.todos (id, user_id, title, created_at, updated_at)
      select gen_random_uuid(), ${e}, 't' || g, 1, 1 from generate_series(1, 2500) g`;
    await sql`insert into public.todos (id, user_id, title, created_at, updated_at) values (gen_random_uuid(), ${other}, 'not-mine', 1, 1)`;
    await sql`insert into public.settings (id, user_id, key, value) select gen_random_uuid(), ${e}, 'k' || g, '1'::jsonb from generate_series(1, 2000) g`;
    await sql`insert into public.logs (user_id, t, kind, act, src) select ${e}, g, 'run', 'x', 'store-it' from generate_series(1, 2300) g`;
    // 期望顺序按列本身的类型排（输出列别名不能叫 id：order by 裸名字先认输出列，会按文本排）
    const ids = async (table: 'todos' | 'settings') =>
      (await sql<{ k: string }[]>`select id::text as k from ${sql(table)} where user_id = ${e} order by id`).map((r) => r.k);
    const wantTodos = await ids('todos');
    const wantSettings = await ids('settings');
    const jwt = await jwtOf(e);
    const { id, at } = await startExport(jwt);
    // 任务行：window_start 带微秒，start 回的 exported_at 是它截到毫秒
    //   取成和 PostgREST 一样的 JSON 写法（to_json：2026-10-31T03:00:00.123456+00:00），看 Date.parse 认不认微秒
    const job = one(await sql<{ w: string; count: number }[]>`select to_json(window_start) #>> '{}' as w, count from private.counters where key like ${`export-job:${e}:${id}.%`}`);
    assert(/\.\d{4,6}\+00:00$/.test(job.w) || /:\d{2}\+00:00$/.test(job.w), `window_start 写法不是预期的：${job.w}`);
    assertEquals(new Date(Date.parse(job.w)).toISOString(), at, 'exported_at 不是任务开始时刻截到毫秒');
    assertEquals(job.count, 0);
    const { doc, parts, bytes } = await fetchAll(jwt, id);
    assertEquals(doc.exported_at, at, '文件头的 exported_at 和 start 回的不一致');
    const got = (t: string) => (doc.tables[t] ?? []).map((x) => x.id);
    assertEquals(got('todos'), wantTodos, 'todos（跨多页）顺序或内容不对');
    assertEquals(got('settings'), wantSettings, 'settings（正好 2000 行）顺序或内容不对');
    const wantLogs = (await sql<{ k: string }[]>`select id::text as k from public.logs where user_id = ${e} and act <> 'export_done' order by id`).map((x) => Number(x.k));
    assertEquals(got('logs'), wantLogs, 'logs（数字主键）顺序或内容不对');
    assert(got('logs').every((x) => typeof x === 'number'), 'logs 的 id 不是数字');
    assert(Object.values(doc.tables).flat().every((x) => x.user_id === e), '包里有别人的行');
    // 四个计数
    const d = today();
    assertEquals(await counter(`account:${e}:${d}`), 1, 'account 计数应 +1');
    assertEquals(await counter(`export-size:${e}:${d}`), 1, 'export-size 计数应 +1');
    assertEquals(await counter(`export-part:${e}:${d}`), parts, 'export-part 计数应等于 part 调用数');
    assertEquals(one(await sql<{ count: number }[]>`select count from private.counters where key like ${`export-job:${e}:${id}.%`}`).count, parts, '任务行 count 应等于片数');
    // logs 两条：code 相同；export_done 的 fields 是片数和 gzip 字节合计
    const rows = await sql<{ act: string; code: string; fields: string[] | null }[]>`select act, code, fields from public.logs
      where user_id = ${e} and src = 'account' and act in ('export', 'export_done') order by id`;
    assertEquals(rows.map((r) => [r.act, r.code]), [['export', id], ['export_done', id]]);
    assertEquals(rows[1]?.fields, [`parts=${parts}`, `bytes=${bytes}`]);
    // 导出通知真发了（Resend 替身收到），没有 export_mail_failed
    const mailTo = emails.get(e) ?? '?';
    for (let i = 0; i < 50 && !mails.includes(mailTo); i++) await sleep(100);
    assert(mails.includes(mailTo), '5 秒内没有给导出的人发通知信');
    await sleep(200);
    assertEquals((await sql`select 1 from public.logs where user_id = ${e} and act = 'export_mail_failed'`).length, 0, '导出通知发信失败');
  } });

  Deno.test({ name: 'account export 真 rpc 的返回形状：export_job_take 回表、微秒 timestamptz 能 Date.parse；bigint 回成数字', ...opts, async fn() {
    const u = await mkUser('shape');
    const sid = crypto.randomUUID();
    const eid = crypto.randomUUID();
    const priv = admin.schema('private');
    const st = await priv.rpc('export_job_start', { p_user: u, p_export_id: eid, p_mode: 'omitted', p_session: sid });
    assert(!st.error && typeof st.data === 'string' && Number.isFinite(Date.parse(st.data)), `export_job_start：${JSON.stringify(st)}`);
    const tk = await priv.rpc('export_job_take', { p_user: u, p_export_id: eid, p_mode: 'omitted', p_session: sid, p_max: 36, p_ttl_s: 3600 });
    assert(!tk.error && Array.isArray(tk.data) && tk.data.length === 1, `export_job_take：${JSON.stringify(tk)}`);
    const row = (tk.data as Record<string, unknown>[])[0] ?? {};
    assertEquals(Object.keys(row).sort(), ['parts', 'started_at', 'verdict']);
    assertEquals([row.verdict, row.parts], ['ok', 1]);
    assertEquals(Date.parse(String(row.started_at)), Date.parse(st.data as string), 'started_at 和开始时刻对不上（微秒解析？）');
    const ex = await priv.rpc('export_job_take', { p_user: u, p_export_id: eid, p_mode: 'cipher', p_session: sid, p_max: 36, p_ttl_s: 3600 });
    assertEquals(ex.data, [{ verdict: 'expired', started_at: null, parts: null }]);
    const sz = await priv.rpc('export_size_over', { p_user: u, p_mode: 'omitted', p_limit: 503316480, p_budget_ms: 15000 });
    assert(!sz.error && typeof sz.data === 'number' && Number.isSafeInteger(sz.data) && sz.data >= 0, `export_size_over：${JSON.stringify(sz)}`);
    const db = await priv.rpc('db_size_bytes');
    const d0 = Array.isArray(db.data) ? (db.data[0] as Record<string, unknown>) : null;
    assert(!db.error && typeof d0?.bytes === 'number' && Number.isFinite(Date.parse(String(d0?.at))), `db_size_bytes：${JSON.stringify(db)}`);
    // 删任务行（start 退回时用的写法）真的删得掉
    const del = await priv.from('counters').delete().like('key', `export-job:${u}:${eid}.%`);
    assert(!del.error, `删任务行失败：${del.error?.message}`);
    assertEquals((await sql`select 1 from private.counters where key like ${`export-job:${u}:${eid}.%`}`).length, 0);
  } });

  Deno.test({ name: 'account export 真库：另一条连接拿住预检的锁 → start 回 try_later，export-size 退回、不扣导出次数，日志 export_size_busy', ...opts, async fn() {
    const u = await mkUser('busy');
    const jwt = await jwtOf(u);
    const conn = await sql.reserve();
    const seen: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); };
    try {
      await conn`select pg_advisory_lock(${SIZE_LOCK})`;
      const r = await callAccount(jwt, { action: 'export', step: 'start' });
      assertEquals([r.status, r.json], [503, { error: 'try_later' }]);
    } finally {
      console.error = orig;
      await conn`select pg_advisory_unlock(${SIZE_LOCK})`.catch(() => {});
      conn.release();
    }
    const d = today();
    assertEquals((await counter(`export-size:${u}:${d}`)) ?? 0, 0, '拿不到锁那次的 export-size 应退回');
    assertEquals((await counter(`account:${u}:${d}`)) ?? 0, 0, '不该扣导出次数');
    assert(seen.some((l) => /account: export_size_busy u=[0-9a-f]{16} ms=\d+/.test(l)), `没有 export_size_busy 日志：${seen.join(' | ')}`);
    assertEquals((await sql`select 1 from public.logs where user_id = ${u} and src = 'account'`).length, 0, '忙的时候不该写 logs');
    // 锁放开以后照常
    const ok = await callAccount(jwt, { action: 'export', step: 'start' });
    assertEquals(ok.status, 200, JSON.stringify(ok.json));
  } });

  Deno.test({ name: 'account export 真库：冷静期账号的 start、part 都被拦（account_pending_deletion），不扣 export-size', ...opts, async fn() {
    const p = await mkUser('pendexp');
    const del = await callAccount(await jwtOf(p), { action: 'delete', confirm: '注销' });
    assertEquals(del.status, 200, JSON.stringify(del.json));
    const jwt = await jwtOf(p);   // 申请注销吊销了全部会话，重新登录拿一个
    const s = await callAccount(jwt, { action: 'export', step: 'start' });
    assertEquals([s.status, s.json?.error], [403, 'account_pending_deletion']);
    const pt = await callAccount(jwt, { action: 'export', step: 'part', export_id: crypto.randomUUID(), cursor: null });
    assertEquals([pt.status, pt.json?.error], [403, 'account_pending_deletion']);
    assertEquals(await counter(`export-size:${p}:${today()}`), null);
    assertEquals(await counter(`export-part:${p}:${today()}`), null);
  } });
}
