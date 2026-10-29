// invite-admin 的 store-it（安全审查建议，照 account-store.it.ts 的做法）：index.ts 里接 PostgREST 的真 store 打本机真库。
// 入口 supabase/tests/store-it/run.mjs（和 account-store.it.ts 一起跑）。不改源码：先把 Deno.serve 换成“只记下处理函数”，
// 再 import invite-admin/index.ts，拿到真处理函数和导出的 makeStore；supabase-js、schema('private') 都是线上同一份代码。
// 覆盖：
//   ① insertInvite：写进 private.invites；同一个 code_hash 再写映射成 'duplicate'（23505 + invites_pkey）；备注 41 个码点被 check 拒（抛错，不当 duplicate）；
//   ② listInvites：gt('expires_at') 过滤掉过期的、eq('created_by') 过滤掉别人的，按 expires_at 倒序，只有四列；
//   ③ isAdmin、takeRate 经 schema('private')；
//   ④ 经处理函数：真 JWT（magiclink 换来）→ 管理员发码 200，库里查不到明文码（整行转文本都搜不到），code_hash = 码的哈希；
//      非管理员 403 not_admin，不写库、不计次数。
// 安全：只打本机（地址不是 127.0.0.1 / localhost / [::1] 就 throw）。开跑先清上次残留：ia-store-it-*@example.com 的用户、
//   备注以 ia-store-it 开头的 invites、本测试用户的 counters 键；跑完照样清理。
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { inviteCodeHash } from '../../functions/_shared/invite-code.ts';

type Handler = (req: Request) => Response | Promise<Response>;

function assert(ok: unknown, msg = '断言失败'): asserts ok {
  if (!ok) throw new Error(msg);
}
function assertEquals(got: unknown, want: unknown, msg = ''): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg ? `${msg}：` : ''}期望 ${w.slice(0, 300)}，实际 ${g.slice(0, 300)}`);
}

// ---------------- 只打本机 ----------------
const API = Deno.env.get('IT_API_URL') ?? '';
const DB = Deno.env.get('IT_DB_URL') ?? '';
const ANON = Deno.env.get('IT_ANON_KEY') ?? '';
const SERVICE = Deno.env.get('IT_SERVICE_KEY') ?? '';
const isLocal = (u: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };
if (!API || !DB || !ANON || !SERVICE) throw new Error('store-it：缺 IT_API_URL / IT_DB_URL / IT_ANON_KEY / IT_SERVICE_KEY，请用 node supabase/tests/store-it/run.mjs 跑');
if (!isLocal(API) || !isLocal(DB)) throw new Error('store-it：只打本机的 Supabase（IT_API_URL / IT_DB_URL 不是 127.0.0.1 / localhost / [::1]）');

const RUN = crypto.randomUUID().slice(0, 8);
const EMAIL_LIKE = 'ia-store-it-%@example.com';
const TAG = 'ia-store-it';

// ---------------- 拿到 invite-admin 的真处理函数和 makeStore ----------------
Deno.env.set('SUPABASE_URL', API);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE);
let captured: Handler | null = null;
const realServe = Deno.serve;
Object.defineProperty(Deno, 'serve', {
  value: (h: Handler) => {
    captured = h;
    return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { transport: 'tcp', hostname: '127.0.0.1', port: 0 } };
  },
  configurable: true, writable: true,
});
const mod = await import('../../functions/invite-admin/index.ts');
Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true, writable: true });
const handlerMaybe = captured as Handler | null;
if (!handlerMaybe) throw new Error('store-it：没拿到 invite-admin/index.ts 的处理函数（Deno.serve 没被调用）');
const handler: Handler = handlerMaybe;

const sql = postgres(DB, { max: 2, onnotice: () => {} });
const admin = createClient(API, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const store = mod.makeStore(admin);
const ours: string[] = [];
const emails = new Map<string, string>();

async function cleanup(ids: readonly string[]) {
  for (const id of ids) {
    if ((await sql`select 1 from auth.users where id = ${id}`).length) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`清理用户失败：${error.message}`);
    }
  }
  if (ids.length) await sql`delete from private.counters where split_part(key, ':', 2) = any(${ids}::text[])`;
  await sql`delete from private.invites where note like ${`${TAG}%`}`;
}

async function mkUser(tag: string, isAdmin: boolean): Promise<string> {
  const email = `ia-store-it-${tag}-${RUN}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`建用户失败：${error?.message}`);
  const id = data.user.id;
  ours.push(id);
  emails.set(id, email);
  await sql`insert into public.profiles (user_id) values (${id}) on conflict (user_id) do nothing`;
  if (isAdmin) await sql`insert into private.admins (user_id) values (${id})`;
  return id;
}

async function jwtOf(id: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: emails.get(id) ?? '' });
  const hash = data?.properties?.hashed_token;
  if (error || !hash) throw new Error(`generateLink 失败：${error?.message}`);
  const v = await anon.auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
  const t = v.data.session?.access_token;
  if (v.error || !t) throw new Error(`verifyOtp 失败：${v.error?.message}`);
  return t;
}

/** 版本门读真 app_config：请求头带库里的 min_client_version（开跑时已断言它不为 null） */
async function appVersion(): Promise<string> {
  const r = await sql<{ v: string | null }[]>`select min_client_version as v from public.app_config where id = 1`;
  const v = r[0]?.v;
  if (!v) throw new Error('本机 app_config.min_client_version 为 null');
  return v;
}

async function callFn(jwt: string, body: unknown, version?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handler(new Request('http://127.0.0.1/functions/v1/invite-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, 'x-app-version': version ?? await appVersion() },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const opts = { sanitizeOps: false, sanitizeResources: false };
const later = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();

Deno.test({ name: 'invite-admin store-it 开跑：本机 app_config.min_client_version 不为 null；清掉上次留下的用户和行', ...opts, async fn() {
  // 版本门那几条靠它：为 null 时一律放行，“版本头为空串回 426”就测不出来
  const mins = await sql<{ v: string | null }[]>`select min_client_version as v from public.app_config where id = 1`;
  assert(mins.length === 1 && mins[0]?.v, '本机 app_config.min_client_version 为 null（或没有 id = 1 这一行）');
  const left = (await sql<{ id: string }[]>`select id::text from auth.users where email like ${EMAIL_LIKE}`).map((r) => r.id);
  await cleanup(left);
  assertEquals((await sql`select 1 from auth.users where email like ${EMAIL_LIKE}`).length, 0);
} });

Deno.test({ name: '①②③ makeStore 打真库：insert / 23505 映射 / check 约束 / list 的 gt 过滤 / isAdmin / takeRate', ...opts, async fn() {
  const a = await mkUser('admin1', true);
  const b = await mkUser('other1', false);
  try {
    const h1 = await inviteCodeHash(`IT${RUN}A`);
    const row = { code_hash: h1, created_by: a, max_uses: 1, used_count: 0, expires_at: later(7), note: `${TAG} 1` };
    assertEquals(await store.insertInvite(row), 'ok', '第一次写');
    assertEquals(await store.insertInvite({ ...row, note: `${TAG} dup` }), 'duplicate', '同一个 code_hash 再写 → duplicate（23505 invites_pkey）');
    // 41 个码点：note 的 check 约束（23514）——抛错，不能当成 duplicate 去重试
    let threw = false;
    try { await store.insertInvite({ ...row, code_hash: await inviteCodeHash(`IT${RUN}B`), note: `${TAG}${'一'.repeat(41 - TAG.length)}` }); } catch { threw = true; }
    assert(threw, '备注 41 个码点应被 check 约束拒绝');
    assertEquals(await store.insertInvite({ ...row, code_hash: await inviteCodeHash(`IT${RUN}C`), note: `${TAG}${'😀'.repeat(40 - TAG.length)}` }), 'ok',
      '40 个码点（含 emoji）能写');

    // ② list：再放一条过期的（本人）和一条别人的
    await store.insertInvite({ ...row, code_hash: await inviteCodeHash(`IT${RUN}D`), expires_at: later(-1), note: `${TAG} expired` });
    await store.insertInvite({ ...row, code_hash: await inviteCodeHash(`IT${RUN}E`), created_by: b, expires_at: later(3), note: `${TAG} other` });
    await store.insertInvite({ ...row, code_hash: await inviteCodeHash(`IT${RUN}F`), expires_at: later(2), note: `${TAG} 2` });
    const rows = await store.listInvites(a, new Date().toISOString(), 100);
    assert(rows.every((r) => Object.keys(r).sort().join(',') === 'expires_at,max_uses,note,used_count'), `list 只该有四列：${JSON.stringify(rows[0])}`);
    const notes = rows.map((r) => r.note);
    assert(!notes.includes(`${TAG} expired`), 'gt 过滤：过期的不该出现');
    assert(!notes.includes(`${TAG} other`), 'eq 过滤：别人的不该出现');
    assertEquals(notes.length, 3, '本人没过期的 3 条');
    assertEquals(notes[notes.length - 1], `${TAG} 2`, '按 expires_at 倒序：2 天后到期的排最后');
    const times = rows.map((r) => Date.parse(r.expires_at ?? ''));
    assert(times.every((t, i) => i === 0 || (times[i - 1] ?? 0) >= t), '按 expires_at 倒序');

    // ③ isAdmin、takeRate
    assertEquals([await store.isAdmin(a), await store.isAdmin(b)], [true, false]);
    const key = `invite-admin:${a}:it${RUN}`;
    assertEquals([await store.takeRate(key, 2, 86400), await store.takeRate(key, 2, 86400), await store.takeRate(key, 2, 86400)], [true, true, false]);
  } finally {
    await cleanup([a, b]);
  }
} });

Deno.test({ name: '④ 经处理函数（真 JWT）：管理员发码 200、库里只有哈希；非管理员 403 不写库', ...opts, async fn() {
  const a = await mkUser('admin2', true);
  const b = await mkUser('other2', false);
  try {
    // 版本头为空串：版本门读真 app_config，回 426、不写库
    const old = await callFn(await jwtOf(a), { action: 'create', note: `${TAG} old` }, '');
    assertEquals(old.status, 426, JSON.stringify(old.json));
    const r = await callFn(await jwtOf(a), { action: 'create', note: `${TAG} e2e` });
    assertEquals(r.status, 200, JSON.stringify(r.json));
    const code = String(r.json.code);
    assert(/^[A-HJ-NP-Z2-9]{12}$/.test(code), `码格式不对：${code}`);
    const inDb = await sql<{ t: string; code_hash: string }[]>`select row_to_json(i)::text as t, code_hash from private.invites i where created_by = ${a}`;
    assertEquals(inDb.length, 1);
    assertEquals(inDb[0]?.code_hash, await inviteCodeHash(code), 'code_hash = 码的哈希');
    assert(!(inDb[0]?.t ?? '').includes(code), '库里整行都不该出现明文码');
    const anywhere = await sql`select 1 from private.invites i where position(${code} in row_to_json(i)::text) > 0`;
    assertEquals(anywhere.length, 0, 'invites 全表都搜不到明文码');

    const list = await callFn(await jwtOf(a), { action: 'list' });
    assertEquals(list.status, 200);
    assertEquals((list.json.invites as { note: string }[]).map((x) => x.note), [`${TAG} e2e`]);

    const n = await callFn(await jwtOf(b), { action: 'create', note: `${TAG} nope` });
    assertEquals([n.status, n.json], [403, { error: 'not_admin' }]);
    assertEquals((await sql`select 1 from private.invites where created_by = ${b}`).length, 0, '非管理员没写库');
    assertEquals((await sql`select 1 from private.counters where key like ${`invite-admin:${b}:%`}`).length, 0, '非管理员没计次数');
  } finally {
    await cleanup([a, b]);
    await sql.end();
  }
} });
