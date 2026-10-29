// K3-store-it 的准备工作（account-store.it.ts 引用）：只打本机的检查、Resend 和 R2 替身、拿两个 index.ts 的真处理函数、
// 库和 Auth 客户端、残留清单与清理、建用户和调用的辅助函数。说明见 account-store.it.ts 文件头。
// import 本文件即完成准备（顶层 await）：环境变量不是本机地址就 throw。
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { createFakeS3 } from '../../../tests/shared/fake-s3.ts';

type Handler = (req: Request) => Response | Promise<Response>;

// ---------------- 断言（不另装 @std/assert：CI 的 deno 只用 npm ci 装好的包） ----------------
export function assert(ok: unknown, msg = '断言失败'): asserts ok {
  if (!ok) throw new Error(msg);
}
export function one<T>(rows: readonly T[]): T {
  const r = rows[0];
  if (r === undefined) throw new Error('查询没有返回行');
  return r;
}
export function assertEquals(got: unknown, want: unknown, msg = ''): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg ? `${msg}：` : ''}期望 ${w.slice(0, 300)}，实际 ${g.slice(0, 300)}`);
}
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// ---------------- 只打本机 ----------------
const API = Deno.env.get('IT_API_URL') ?? '';
const DB = Deno.env.get('IT_DB_URL') ?? '';
const ANON = Deno.env.get('IT_ANON_KEY') ?? '';
const SERVICE = Deno.env.get('IT_SERVICE_KEY') ?? '';
const isLocal = (u: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };
if (!API || !DB || !ANON || !SERVICE) throw new Error('store-it：缺 IT_API_URL / IT_DB_URL / IT_ANON_KEY / IT_SERVICE_KEY，请用 node supabase/tests/store-it/run.mjs 跑');
if (!isLocal(API) || !isLocal(DB)) throw new Error('store-it：只打本机的 Supabase（IT_API_URL / IT_DB_URL 不是 127.0.0.1 / localhost / [::1]）');

const CRON = 'store-it-cron-secret-0123456789abcdef-only-local';
const RUN = crypto.randomUUID().slice(0, 8);
export const EMAIL_LIKE = 'k3-store-it-%@example.com';
const LEDGER = 'supabase/.temp/store-it-ids.json';
export const BACKUP_DATE = '20261101';
export const START = new Date();

// ---------------- Resend 替身：拦 fetch ----------------
const realFetch = globalThis.fetch;
export const mails: string[] = [];
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://api.resend.com/')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { to?: string[] };
    mails.push(...(body.to ?? []));
    return new Response('{"id":"fake"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ---------------- R2：仓库的 S3 替身 ----------------
const S3_KEY = 'store-it-key', S3_SECRET = 'store-it-secret';
export const fakeS3 = createFakeS3({ accessKeyId: S3_KEY, secretAccessKey: S3_SECRET, buckets: ['images', 'files', 'vault-images', 'vault-files'] });
fakeS3.pageSize = 2;   // 删前缀时真的走 ListObjectsV2 翻页
const realServe = Deno.serve;
export const s3Server = realServe({ hostname: '127.0.0.1', port: 0, onListen() {} }, (r) => fakeS3.handle(r));
export const s3Put = (bucket: string, key: string) =>
  fakeS3.objects.set(`${bucket}/${key}`, { body: new Uint8Array([1]), contentType: 'application/octet-stream', etag: '"e"' });
export const s3Has = (bucket: string, key: string) => fakeS3.objects.has(`${bucket}/${key}`);

// ---------------- 两个函数的环境变量，然后拿到真处理函数 ----------------
const ENV: Record<string, string> = {
  SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SERVICE, RESEND_API_KEY: 're_store_it_fake', PROXY_SECRET: 'store-it-proxy',
  CRON_SECRET: CRON, SIGNUP_HASH_SECRET: 'store-it-signup-hash-secret-only-local',
  R2_ENDPOINT: `http://127.0.0.1:${s3Server.addr.port}`, R2_FN_ACCESS_KEY_ID: S3_KEY, R2_FN_SECRET_ACCESS_KEY: S3_SECRET, R2_BUCKET_PREFIX: '',
};
for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);

let captured: Handler | null = null;
const fakeServe = (h: Handler) => {
  captured = h;
  return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { transport: 'tcp', hostname: '127.0.0.1', port: 0 } };
};
Object.defineProperty(Deno, 'serve', { value: fakeServe, configurable: true, writable: true });
await import('../../functions/account/index.ts');
const accountMaybe = captured as Handler | null;
captured = null;
export const purgeMod = await import('../../functions/account-purge/index.ts');
const purgeMaybe = captured as Handler | null;
Object.defineProperty(Deno, 'serve', { value: realServe, configurable: true, writable: true });
if (!accountMaybe || !purgeMaybe) throw new Error('store-it：没拿到两个 index.ts 的处理函数（Deno.serve 没被调用）');
const accountH: Handler = accountMaybe;
const purgeH: Handler = purgeMaybe;

// ---------------- 库、Auth ----------------
export const sql = postgres(DB, { max: 4, onnotice: () => {} });
export const admin = createClient(API, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(API, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
export const ours: string[] = [];
export const emails = new Map<string, string>();

async function readLedger(): Promise<string[]> {
  try { return (JSON.parse(await Deno.readTextFile(LEDGER)) as unknown[]).filter((x): x is string => typeof x === 'string'); } catch { return []; }
}
export const writeLedger = (ids: readonly string[]) => Deno.writeTextFile(LEDGER, JSON.stringify(ids));

/** 删一批 id 的一切痕迹（用户还在就 deleteUser，级联删库里的行；不在 auth.users 的痕迹另删） */
export async function purgeTraces(ids: readonly string[]) {
  if (!ids.length) return;
  for (const id of ids) {
    if ((await sql`select 1 from auth.users where id = ${id}`).length) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`清理用户失败：${error.message}`);
    }
    const files = (await admin.storage.from('backups').list(`${BACKUP_DATE}/${id}`)).data ?? [];
    if (files.length) await admin.storage.from('backups').remove(files.map((f) => `${BACKUP_DATE}/${id}/${f.name}`));
  }
  await sql`delete from private.deleted_accounts where user_id = any(${ids}::uuid[])`;
  await sql`delete from private.counters where split_part(key, ':', 2) = any(${ids}::text[])`;
}

/** 开跑前：上次被 kill 留下的东西 */
export async function healLeftovers() {
  await sql`drop schema if exists store_it cascade`;
  const byEmail = (await sql<{ id: string }[]>`select id::text from auth.users where email like ${EMAIL_LIKE}`).map((r) => r.id);
  await purgeTraces([...new Set([...(await readLedger()), ...byEmail])]);
  await writeLedger([]);
}

export async function mkUser(tag: string, withProfile = true): Promise<string> {
  const email = `k3-store-it-${tag}-${RUN}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`建用户失败：${error?.message}`);
  const id = data.user.id;
  ours.push(id);
  await writeLedger(ours);   // 先记账再用：中途被 kill，下次开跑能找到
  emails.set(id, email);
  if (withProfile) await sql`insert into public.profiles (user_id) values (${id}) on conflict (user_id) do nothing`;
  return id;
}

/** 冷静期：停用 deletion + pending_deletions（相对数据库 now()，秒） */
export async function pending(id: string, purgeAfterS: number, claimedAgoS: number | null = null) {
  await sql`update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = ${id}`;
  await sql`insert into private.pending_deletions (user_id, purge_after, purge_started_at)
    values (${id}, now() + make_interval(secs => ${purgeAfterS}),
            case when ${claimedAgoS}::int is null then null else now() - make_interval(secs => ${claimedAgoS}::int) end)`;
}

/** 别人的到期（或 49 小时内到期、会收提醒）的 pending 行：有就不调 account-purge */
async function othersDue(): Promise<number> {
  const r = one(await sql<{ n: number }[]>`select count(*)::int as n from private.pending_deletions
    where purge_after <= now() + interval '49 hours' and not (user_id = any(${ours}::uuid[]))`);
  return r.n;
}

export async function runPurge(): Promise<Record<string, unknown>> {
  assertEquals(await othersDue(), 0, '本机库里有别人的到期 pending_deletions，不调 account-purge（免得删掉别人的账号）');
  const res = await purgeH(new Request('http://127.0.0.1/functions/v1/account-purge', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': CRON }, body: '{}',
  }));
  const body = (await res.json()) as Record<string, unknown>;
  assertEquals(res.status, 200, JSON.stringify(body));
  return body;
}

export async function callAccount(jwt: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null; res: Response }> {
  const res = await accountH(new Request('http://127.0.0.1/functions/v1/account', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
  }));
  const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json');
  return { status: res.status, json: isJson ? ((await res.clone().json()) as Record<string, unknown>) : null, res };
}

export const userExists = async (id: string) => (await sql`select 1 from auth.users where id = ${id}`).length === 1;
export const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
export const counter = async (key: string) => (await sql<{ count: number }[]>`select count from private.counters where key = ${key} order by window_start desc limit 1`)[0]?.count ?? null;

export async function jwtOf(id: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: emails.get(id) ?? '' });
  const hash = data?.properties?.hashed_token;
  if (error || !hash) throw new Error(`generateLink 失败：${error?.message}`);
  const v = await anon.auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
  const t = v.data.session?.access_token;
  if (v.error || !t) throw new Error(`verifyOtp 失败：${v.error?.message}`);
  return t;
}
