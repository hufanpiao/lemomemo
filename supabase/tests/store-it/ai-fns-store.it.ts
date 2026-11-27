// B3 的 AI 函数 store-it（架构审第九节第 3 条；代码审 M4；TC-B3-25、TC-B3-29、TC-B1-10）：
//   按真实的 index.ts 组装（先把 Deno.serve 换成“只记下处理函数”，再 import ai-parse、ai-voice、token-admin、claude-intake 的 index.ts），
//   真 requireActiveUser / isUsable / aiAllowed / gateDeps / store.ts，打本机真库（lemo-e2e 或 CI 那套）。入口 supabase/tests/store-it/run.mjs。
// Gemini 一律不联网：把 globalThis.fetch 换成替身，地址是 generativelanguage.googleapis.com 的记一次、回预设的响应，别的照常（只有 127.0.0.1）。
// 覆盖：
//   ① TC-B1-10：真 JWT、没有 profiles 行的账号调 ai-parse、ai-voice、token-admin，真 requireActiveUser 先拦，403 account_disabled；
//      不调 Gemini、不计数、不建连接码；
//   ② 第 3 条：没同意 AI 的人调 ai-parse、ai-voice 回 consent_required，Gemini 0 次，private.counters 里这个人一个键都没有；
//      claude-intake 同一个人用连接码记一句本机没把握的话：按本机规则记下（经 private.intake_insert 写进真表），Gemini 0 次、AI 计数不动；
//   ③ TC-B3-29：同意了的人 ai-parse 成功一次，库里 ai:<uid>:<太平洋日期> 合计 1，用本人 JWT 调 my_ai_usage() 看到 ai_used = 1；
//      再调一次 Gemini 回 500：预扣退回，my_ai_usage 仍是 1；
//   ④ claude-intake 一句话里有日程和待办：两张表的行都在（一个事务写完）；
//   ⑤ 安全审查第 12 条：token-admin 建码经 private.api_token_create，并发两笔冲不破 5 个上限。
// 改 app_config.ai（provider、model、global_daily）跑 ③，结束时原样恢复。
// 安全：只打本机。开跑先清上次残留：ai-store-it-*@example.com 的用户和他们的 counters；跑完照样清理。
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { randomToken, tokenHash } from '../../functions/_shared/intake-token.ts';

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
const EMAIL_LIKE = 'ai-store-it-%@example.com';

// ---------------- Gemini 替身（不联网） ----------------
const GEMINI = 'https://generativelanguage.googleapis.com/';
const realFetch = globalThis.fetch;
let geminiCalls = 0;
let geminiReply: () => Response = () => new Response('{}', { status: 500 });
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(GEMINI)) {
    geminiCalls++;
    return Promise.resolve(geminiReply());
  }
  if (!isLocal(url)) return Promise.reject(new Error(`store-it：不准连外网（${new URL(url).hostname}）`));
  return realFetch(input, init);
}) as typeof fetch;

// ---------------- 拿到四个函数的真处理函数 ----------------
Deno.env.set('SUPABASE_URL', API);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE);
Deno.env.set('GEMINI_API_KEY', 'store-it-fake-key');   // 只进替身的请求头
const realServe = Deno.serve;
async function handlerOf(name: string, load: () => Promise<unknown>): Promise<Handler> {
  let captured: Handler | null = null;
  Object.defineProperty(Deno, 'serve', {
    value: (h: Handler) => {
      captured = h;
      return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { transport: 'tcp', hostname: '127.0.0.1', port: 0 } };
    },
    configurable: true, writable: true,
  });
  try {
    await load();
  } finally {
    Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true, writable: true });
  }
  const h = captured as Handler | null;
  if (!h) throw new Error(`store-it：没拿到 ${name}/index.ts 的处理函数`);
  return h;
}
const H = {
  parse: await handlerOf('ai-parse', () => import('../../functions/ai-parse/index.ts')),
  voice: await handlerOf('ai-voice', () => import('../../functions/ai-voice/index.ts')),
  tokenAdmin: await handlerOf('token-admin', () => import('../../functions/token-admin/index.ts')),
  intake: await handlerOf('claude-intake', () => import('../../functions/claude-intake/index.ts')),
};

const sql = postgres(DB, { max: 2, onnotice: () => {} });
const admin = createClient(API, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const ours: string[] = [];
const emails = new Map<string, string>();
const opts = { sanitizeOps: false, sanitizeResources: false };

async function cleanup(ids: readonly string[]) {
  for (const id of ids) {
    if ((await sql`select 1 from auth.users where id = ${id}`).length) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`清理用户失败：${error.message}`);
    }
  }
  if (ids.length) await sql`delete from private.counters where split_part(key, ':', 2) = any(${ids}::text[])`;
}

async function mkUser(tag: string, withProfile = true): Promise<string> {
  const email = `ai-store-it-${tag}-${RUN}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`建用户失败：${error?.message}`);
  const id = data.user.id;
  ours.push(id);
  emails.set(id, email);
  if (withProfile) await sql`insert into public.profiles (user_id) values (${id}) on conflict (user_id) do nothing`;
  return id;
}

/** 同意 AI：profiles 记同意时间和当前隐私说明版本，settings 里 ai.enabled = true（同 record_consent + 设置开关的结果） */
async function consent(id: string) {
  await sql`update public.profiles set consent_ai_at = now(),
    consent_policy_ver = (select notice ->> 'policy_ver' from public.app_config where id = 1) where user_id = ${id}`;
  await sql`insert into public.settings (id, user_id, key, value) values (gen_random_uuid(), ${id}, 'ai.enabled', 'true')
    on conflict (user_id, key) do update set value = 'true', deleted_at = null, undone = false`;
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

async function appVersion(): Promise<string> {
  const v = (await sql<{ v: string | null }[]>`select min_client_version as v from public.app_config where id = 1`)[0]?.v;
  if (!v) throw new Error('本机 app_config.min_client_version 为 null');
  return v;
}

const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const pacificToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
/** 这个人在 counters 里的所有键（ai:、ai-rate:、claude-intake…:） */
const keysOf = async (id: string) => (await sql<{ key: string }[]>`select key from private.counters where split_part(key, ':', 2) = ${id} order by key`).map((r) => r.key);
const aiUsed = async (id: string) =>
  (await sql<{ n: number }[]>`select coalesce(sum(count), 0)::int as n from private.counters where key = ${`ai:${id}:${pacificToday()}`}`)[0]?.n ?? -1;

async function call(h: Handler, path: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await h(new Request(`http://127.0.0.1/functions/v1/${path}`, { method: 'POST', ...init }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const parseReq = async (jwt: string, text: string): Promise<RequestInit> => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, 'x-app-version': await appVersion() },
  body: JSON.stringify({ text, now: Date.now(), tz: 'Asia/Seoul', locale: 'zh' }),
});
const voiceReq = async (jwt: string): Promise<RequestInit> => ({
  headers: { 'content-type': 'audio/webm', authorization: `Bearer ${jwt}`, 'x-app-version': await appVersion(), 'x-now': String(Date.now()), 'x-tz': 'Asia/Seoul' },
  body: new Uint8Array(1024),
});

Deno.test({ name: 'ai-fns store-it 开跑：清掉上次留下的用户和计数', ...opts, async fn() {
  const left = (await sql<{ id: string }[]>`select id::text from auth.users where email like ${EMAIL_LIKE}`).map((r) => r.id);
  await cleanup(left);
  assertEquals((await sql`select 1 from auth.users where email like ${EMAIL_LIKE}`).length, 0);
} });

Deno.test({ name: 'TC-B3-29：同意了的人 ai-parse 成功一次，my_ai_usage() 看到的 = 服务器扣的；失败退回后不变', ...opts, async fn() {
  const u = await mkUser('consent');
  await consent(u);
  const jwt = await jwtOf(u);
  const old = (await sql<{ ai: unknown }[]>`select ai from public.app_config where id = 1`)[0]?.ai;
  await sql`update public.app_config set ai = ai || '{"provider": "gemini", "model": "gemini-2.5-flash", "global_daily": 100000}'::jsonb where id = 1`;
  try {
    const due = new Date(Date.parse(`${seoulToday()}T00:00:00Z`) + 3 * 86400_000).toISOString().slice(0, 10);
    geminiReply = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      items: [{ kind: 'todo', title: '和老王聊合同', due, date_basis: 'rel' }],
    }) }] } }] }), { status: 200 });
    const before = geminiCalls;
    // app_config 有 60 秒缓存（wire.ts）：这条排在最前面，第一次读就是改过的配置；万一读到旧的，最多等它过期
    let r = await call(H.parse, 'ai-parse', await parseReq(jwt, '下周找时间和老王聊聊合同的事'));
    for (let i = 0; i < 13 && r.json['fallback'] === true; i++) {
      await new Promise((ok) => setTimeout(ok, 5000));
      r = await call(H.parse, 'ai-parse', await parseReq(jwt, '下周找时间和老王聊聊合同的事'));
    }
    assertEquals(r.status, 200, JSON.stringify(r.json));
    assertEquals((r.json['items'] as { title: string }[]).map((x) => x.title), ['和老王聊合同'], JSON.stringify(r.json));
    assertEquals(geminiCalls - before, 1, 'Gemini 1 次（替身）');
    assertEquals(await aiUsed(u), 1, '库里扣了 1 次');
    const userClient = createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const m1 = await userClient.rpc('my_ai_usage');
    assertEquals(m1.error, null, 'my_ai_usage 调得通');
    const u1 = m1.data as { ai_used: number; ai_limit: number; pacific_date: string };
    assertEquals([u1.ai_used, u1.pacific_date], [1, pacificToday()], 'TC-B3-29：设置看到的 = 服务器扣的');
    geminiReply = () => new Response('{}', { status: 500 });
    const f = await call(H.parse, 'ai-parse', await parseReq(jwt, '下周找时间和老王聊聊合同的事'));
    assertEquals(f.json, { fallback: true, reason: 'error' }, '失败回 fallback');
    assertEquals(await aiUsed(u), 1, '失败退回：库里仍是 1');
    assertEquals(((await userClient.rpc('my_ai_usage')).data as { ai_used: number }).ai_used, 1, 'my_ai_usage 仍是 1');
  } finally {
    await sql`update public.app_config set ai = ${sql.json(old as never)} where id = 1`;
    geminiReply = () => new Response('{}', { status: 500 });
  }
} });

Deno.test({ name: 'TC-B1-10：真 JWT、没有 profiles 行的账号调 ai-parse、ai-voice、token-admin 回 403 account_disabled（真 requireActiveUser）', ...opts, async fn() {
  const u = await mkUser('noprof', false);
  const jwt = await jwtOf(u);
  const before = geminiCalls;
  const p = await call(H.parse, 'ai-parse', await parseReq(jwt, '下周找时间和老王聊聊合同的事'));
  assertEquals([p.status, p.json], [403, { error: 'account_disabled' }], 'ai-parse');
  const v = await call(H.voice, 'ai-voice', await voiceReq(jwt));
  assertEquals([v.status, v.json], [403, { error: 'account_disabled' }], 'ai-voice');
  const t = await call(H.tokenAdmin, 'token-admin', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, 'x-app-version': await appVersion() },
    body: JSON.stringify({ action: 'create' }),
  });
  assertEquals([t.status, t.json], [403, { error: 'account_disabled' }], 'token-admin');
  assertEquals(geminiCalls - before, 0, 'Gemini 0 次');
  assertEquals(await keysOf(u), [], '不计数');
  assertEquals((await sql`select 1 from public.api_tokens where user_id = ${u}`).length, 0, '不建连接码');
} });

Deno.test({ name: '安全审查第 12 条：token-admin 经 private.api_token_create 建码；已有 4 个有效码时并发两笔只成一笔、另一笔 409', ...opts, async fn() {
  const u = await mkUser('tokcap');
  const jwt = await jwtOf(u);
  for (let i = 0; i < 4; i++) await sql`insert into public.api_tokens (user_id, token_hash) values (${u}, ${await tokenHash(randomToken())})`;
  const req = async (): Promise<RequestInit> => ({
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, 'x-app-version': await appVersion() },
    body: JSON.stringify({ action: 'create', label: 'store-it' }),
  });
  const rs = await Promise.all([call(H.tokenAdmin, 'token-admin', await req()), call(H.tokenAdmin, 'token-admin', await req())]);
  assertEquals(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.json)));
  assertEquals(rs.find((r) => r.status === 409)?.json, { error: 'too_many_tokens' }, '409 的那一笔');
  const live = await sql<{ n: number; s: string }[]>`select count(*)::int as n, string_agg(distinct array_to_string(scopes, ','), '|') as s
    from public.api_tokens where user_id = ${u} and revoked_at is null`;
  assertEquals([live[0]?.n, live[0]?.s], [5, 'create'], '有效码正好 5 个，scopes 都是 {create}');
  assertEquals(await keysOf(u), [`token-admin:${u}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`], '只成的那一笔计了次数');
} });

Deno.test({ name: '架构审第九节第 3 条：没同意 AI，ai-parse、ai-voice 回 consent_required，Gemini 0 次、计数不动；claude-intake 只走本机规则', ...opts, async fn() {
  const u = await mkUser('noconsent');
  const jwt = await jwtOf(u);
  const before = geminiCalls;
  const p = await call(H.parse, 'ai-parse', await parseReq(jwt, '下周找时间和老王聊聊合同的事'));
  assertEquals([p.status, p.json], [200, { consent_required: true }], 'ai-parse');
  const v = await call(H.voice, 'ai-voice', await voiceReq(jwt));
  assertEquals([v.status, v.json], [200, { consent_required: true }], 'ai-voice');
  // claude-intake：同一个人建一个连接码（库里只存哈希）
  const token = randomToken();
  await sql`insert into public.api_tokens (user_id, token_hash, label) values (${u}, ${await tokenHash(token)}, 'store-it')`;
  const c = await call(H.intake, 'claude-intake', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-app-version': '4.0.0' },
    body: JSON.stringify({ text: '下周找时间和老王聊聊合同的事' }),
  });
  assertEquals(c.status, 200, JSON.stringify(c.json));
  const created = c.json['created'] as { title: string }[];
  assertEquals(created.map((x) => x.title), ['下周找时间和老王聊聊合同的事'], '本机规则的结果（没把握也照记，原话不丢）');
  assertEquals(geminiCalls - before, 0, '三个函数 Gemini 一共 0 次');
  assert((await keysOf(u)).every((k) => !k.startsWith('ai:') && !k.startsWith('ai-rate:')), `AI 计数不动：${(await keysOf(u)).join(',')}`);
  const rows = await sql<{ source: string; raw_text: string }[]>`select source, raw_text from public.todos where user_id = ${u}`;
  assertEquals(rows.map((r) => [r.source, r.raw_text]), [['chat', '下周找时间和老王聊聊合同的事']], '经 private.intake_insert 写进真表');
  // 一句话里有日程和待办：两张表一个事务写完
  const two = await call(H.intake, 'claude-intake', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-app-version': '4.0.0' },
    body: JSON.stringify({ text: '明天下午3点开会，后天交报告' }),
  });
  assertEquals(two.status, 200, JSON.stringify(two.json));
  assertEquals((await sql`select 1 from public.events where user_id = ${u} and source = 'chat'`).length, 1, '日程一条');
  assertEquals((await sql`select 1 from public.todos where user_id = ${u} and source = 'chat'`).length, 2, '待办共两条');
} });

Deno.test({ name: 'ai-fns store-it 收尾：清理用户和计数，关连接', ...opts, async fn() {
  try {
    await cleanup(ours);
  } finally {
    await sql.end();
    globalThis.fetch = realFetch;
  }
} });
