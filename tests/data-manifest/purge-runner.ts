// 注销用例的 runner（对象存储那一半；架构 3.5 第 4 点、0.32；TC-B0-117）：接生成器产出的 runner = 'objstore'、kind = 'account-delete' 用例
// 流程：造数据（tests/fakes/objstore-seed.ts，A、B 在四个 R2 桶每一段路径都有对象）→ 探针 → account-delete（A 申请注销，进冷静期）
//       → 探针（冷静期里什么都不能少）→ account-purge（冷静期满，永久清除）→ 探针（删完再列一次：A 为 0，B 不变）
// 探针一律用前端 B 的 runObjProbe（objstore-probe.ts），存储一律按 shared/objstore.ts 的 ObjStore 接口传进来：
//   离线：tests/fakes/objstore-memory.ts 的内存替身 + memoryPurgeActs（按清单删 R2 前缀的替身，只代表 account-purge 对对象存储该做的事）
//   真函数（TC-B0-117，B1）：本地 Supabase + S3 后端 + 真的 account（delete）/ account-purge 的 index.ts，见文末 startLivePurge。
//     S3 后端二选一，同一份测试代码：仓库替身 tests/shared/fake-s3.ts（fetch 层转给它；正向、反证用例都用）；
//     或真的 S3 兼容实现 LocalStack（设了 OBJSTORE_ENDPOINT 时，只跑正向用例，删除语义由它认定；B1 接手清单 B0-117-dev）。真 R2 的一遍由负责人做
// runner = 'sql' 的注销用例（store = 'supabase' 的桶、表）不归这里，由 SQL runner 打本地库（待 Docker）

import type { ObjStore } from '../../shared/objstore.ts';
import { putSeedObjects, R2_BUCKETS, SEED_USERS, type SeedObject, seedObjects } from '../fakes/objstore-seed.ts';
import { type ProbeResult, matches, runObjProbe } from './objstore-probe.ts';
import type { GeneratedCase } from './sql.ts';
import type { Manifest } from './types.ts';
import { headBuckets, isLoopback, type LiveS3, realS3Backend, type S3Call, s3Route, sweepRealPrefixes } from './live-s3.ts';
import { LIVE_LOCK, takeLiveLock } from './live-lock.ts';

/** 注销的两步动作：离线是替身，真替身是调本地 Supabase 的函数 */
export interface PurgeActs {
  /** A 申请注销（进入 7 天冷静期；对象存储里什么都不删） */
  accountDelete(userId: string): Promise<void>;
  /** 冷静期满，永久清除（B1 的 account-purge；对象存储里删掉 A 的全部对象并再列一次确认为 0） */
  accountPurge(userId: string): Promise<void>;
}

export interface PurgeRunEnv {
  store: Pick<ObjStore, 'put' | 'listAll' | 'head'>;
  acts: PurgeActs;
  /** 造的数据，默认 seedObjects()（A、B 用 SEED_USERS 的 id） */
  seed?: readonly SeedObject[];
}

export interface CaseOutcome {
  id: string;
  ok: boolean;
  problems: string[];
  before: ProbeResult;
  afterDelete: ProbeResult;
  afterPurge: ProbeResult;
}

/** 生成器的用例里哪些归这个 runner */
export function purgeCases(cases: readonly GeneratedCase[]): GeneratedCase[] {
  return cases.filter((c) => c.runner === 'objstore' && c.kind === 'account-delete');
}

const fmt = (r: ProbeResult) => (r.mode === 'count' ? `A ${r.a}、B ${r.b}` : r.mode === 'snapshot' ? `${r.digest.split('\n').filter(Boolean).length} 个 key` : JSON.stringify(r.present));

/** 造的数据够不够：count 模式每个选择器（每一段路径）A、B 都至少有一个对象，否则“删完为 0”说明不了问题 */
function coverage(c: GeneratedCase, seed: readonly SeedObject[]): string[] {
  const p = c.objProbe;
  if (!p || p.mode !== 'count') return [];
  const out: string[] = [];
  for (const sel of p.selectors ?? []) {
    for (const who of ['a', 'b'] as const) {
      const user = SEED_USERS[who];
      if (!seed.some((o) => o.bucket === p.bucket && matches(sel, o.key, user))) out.push(`造数据没覆盖 ${p.bucket} 的 ${sel.prefix || '（整桶）'}${sel.pattern ? ` ${sel.pattern}` : ''}（${who.toUpperCase()}）`);
    }
  }
  return out;
}

function judge(c: GeneratedCase, before: ProbeResult, afterDelete: ProbeResult, afterPurge: ProbeResult): string[] {
  const out: string[] = [];
  if (JSON.stringify(afterDelete) !== JSON.stringify(before)) out.push(`冷静期里对象变了：注销前 ${fmt(before)}，account-delete 后 ${fmt(afterDelete)}`);
  if (before.mode === 'count' && afterPurge.mode === 'count') {
    if (before.a === 0 || before.b === 0) out.push(`注销前 A 或 B 没有对象（${fmt(before)}），用例不成立`);
    if (afterPurge.a !== 0) out.push(`account-purge 之后 A 还剩 ${afterPurge.a} 个`);
    if (afterPurge.b !== before.b) out.push(`account-purge 动了 B 的对象：${before.b} → ${afterPurge.b}`);
  } else if (before.mode === 'snapshot' && afterPurge.mode === 'snapshot') {
    if (afterPurge.digest !== before.digest) out.push('noUserData 的桶在注销前后变了');
  } else out.push(`${c.id}：探针模式 ${before.mode} 不是注销用例该有的（count / snapshot）`);
  return out;
}

/**
 * 跑全部注销用例：造一次数据，A 走一遍 account-delete → account-purge，每条用例在三个时间点各探一次。
 * 返回每条用例的结果（ok = false 时 problems 写原因）；cases 里不归这个 runner 的会被忽略
 */
export async function runPurgeCases(cases: readonly GeneratedCase[], env: PurgeRunEnv): Promise<CaseOutcome[]> {
  const mine = purgeCases(cases);
  if (mine.length === 0) throw new Error('purge-runner：没有 runner = objstore 的注销用例');
  const seed = env.seed ?? seedObjects();
  const vars = { user_a: SEED_USERS.a, user_b: SEED_USERS.b };
  const probeAll = () => Promise.all(mine.map((c) => runObjProbe(env.store, c.objProbe ?? { bucket: c.target, mode: 'count' }, vars)));

  await putSeedObjects(env.store, seed);
  const before = await probeAll();
  await env.acts.accountDelete(SEED_USERS.a);
  const afterDelete = await probeAll();
  await env.acts.accountPurge(SEED_USERS.a);
  const afterPurge = await probeAll();

  return mine.map((c, i) => {
    const b = before[i] as ProbeResult, d = afterDelete[i] as ProbeResult, p = afterPurge[i] as ProbeResult;
    const problems = [...coverage(c, seed), ...judge(c, b, d, p)];
    return { id: c.id, ok: problems.length === 0, problems, before: b, afterDelete: d, afterPurge: p };
  });
}

/**
 * 离线替身：account-delete 只记“在冷静期”；account-purge 要求先 account-delete，然后按清单把每个 R2 桶里这个人的对象删光
 * （第一级是 user_id 的段用 deletePrefix，删完它自己再列一次；按第几级目录找人的段列整桶再筛）。
 * 这不是 B1 的 account-purge，只是它对对象存储该做的事的最小模型，让 runner 的流程和判定在不起 Docker 时也能跑通
 */
export function memoryPurgeActs(store: Pick<ObjStore, 'listAll' | 'deleteMany' | 'deletePrefix'>, manifests: readonly Manifest[]): PurgeActs & { pending: Set<string> } {
  const pending = new Set<string>();
  const segs = manifests.flatMap((m) => m.buckets ?? []).filter((b) => b.store === 'r2' && !b.noUserData);
  return {
    pending,
    async accountDelete(user) { pending.add(user); },
    async accountPurge(user) {
      if (!pending.has(user)) throw new Error('account_purge_not_pending');
      for (const b of segs) {
        const lk = b.userLookup;
        if (!lk || lk.by !== 'pathPattern') throw new Error(`purge 替身：${b.name} 不按路径找人`);
        if (lk.level === 1) { await store.deletePrefix(b.name, `${user}/`); continue; }
        const keys = (await store.listAll(b.name, '')).map((o) => o.key).filter((k) => k.split('/')[lk.level - 1] === user);
        if (keys.length) await store.deleteMany(b.name, keys);
      }
      pending.delete(user);
    },
  };
}


// ---------------- 真函数那一遍（TC-B0-117，架构 0.33 第 1 条挪到 B1） ----------------
// 本地 Supabase（真库、真 Auth、真 Storage）+ 仓库的 S3 替身（tests/shared/fake-s3.ts，自己验 SigV4、核 Content-MD5；由调用方用 LIVE_S3_KEY / LIVE_S3_SECRET 建好传进来，
//   本文件不引它：tests/functions/account-purge.test.ts 也引本文件，Workers 那套 tsc 没有 node 类型）
// + 两个服务器函数的真 index.ts（account 的 delete、account-purge）。和 supabase/tests/store-it 同一个办法：
//   先把 Deno.serve 换成“只记下处理函数”、Deno.env 换成本测试的变量，再 import index.ts，拿到真处理函数直接喂 Request；
//   store、supabase-js、Storage、objstore 客户端都是线上同一份代码。index.ts 写的是 npm:包@版本，Node 认不得：
//   vitest.config.ts 的 node 项目按 supabase/functions/deno.json 的 imports 把它们别名到 node_modules 里同一版本的包。
//   _shared/gen/ 不进仓库，要先 npm run copy:shared（CI 的 db 任务在启动本地 Supabase 之前已经跑过）。
// 连接只取 IT_API_URL、IT_DB_URL、IT_ANON_KEY、IT_SERVICE_KEY（和 store-it 同名；CI 由 supabase status -o json 填），不是本机地址就拒绝。
// 安全：account-purge 会处理库里所有到期的 pending_deletions。每次调之前查别人 49 小时内到期的行，有就失败、不调；
//   两个测试文件可能在两个 worker 里同时跑，store-it（supabase/tests/store-it/harness.ts）也调 account-purge，三处用同一把会话级 pg_advisory_lock（117117，live-lock.ts；最多等 45 秒，超时报“等锁超时”）串行；开跑先清上次残留（只删邮箱是 purge-it-*@example.com 的用户；
//   SEED_USERS 的 id 被别的邮箱占着就报错退出、不删），跑完再清；心跳 account-purge 那一行跑前记下、跑完还原。
// 网络：fetch 打 LIVE_S3_ENDPOINT 的转给 S3 替身（照样带 SigV4 签名、替身照样验），LocalStack 后端则原样发给 OBJSTORE_ENDPOINT（只许本机）；
//   两种后端的 S3 请求都记进 s3Calls；拦 fetch('https://api.resend.com/…') 只记收件人；
//   其余只许连本机地址。account 的第一封信在响应之后发：挂一个 EdgeRuntime.waitUntil 把这些后台任务记下，close 时等它们全部结束再还原；
//   还原后的 fetch 也不是原来那个，而是“只许本机”的守卫（任何时刻都打不到 api.resend.com 等远端）。

/** 本测试连的本地 Supabase */
export interface LiveSupabase { apiUrl: string; dbUrl: string; anonKey: string; serviceKey: string }

/** 真链路用例和它们的 beforeAll / afterAll 的超时（实际每条约 1 秒；本地库忙时留足余量） */
export const LIVE_TIMEOUT_MS = 60_000;

const urlOf = (input: Request | URL | string) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** 四个变量缺一个就是 null（调用方 describe.skipIf） */
export function liveSupabase(read: (name: string) => string | undefined): LiveSupabase | null {
  const apiUrl = read('IT_API_URL'), dbUrl = read('IT_DB_URL'), anonKey = read('IT_ANON_KEY'), serviceKey = read('IT_SERVICE_KEY');
  return apiUrl && dbUrl && anonKey && serviceKey ? { apiUrl, dbUrl, anonKey, serviceKey } : null;
}

/** “只许本机”的 fetch：close 之后留在 globalThis 上的就是它（晚到的后台请求打远端会被拒） */
export function loopbackOnlyFetch(real: typeof fetch): typeof fetch {
  return ((input: Request | URL | string, init?: RequestInit) => {
    const url = urlOf(input);
    if (!isLoopback(url.href)) return Promise.reject(new Error(`live purge：不许连 ${url.hostname}（只许本机）`));
    return real(input, init);
  }) as typeof fetch;
}

type Handler = (req: Request) => Response | Promise<Response>;
/** 已拿到的处理函数：同一个 worker 里 index.ts 只执行一次（模块缓存），第二次 startLivePurge 复用；处理函数每次请求才读 Deno.env、EdgeRuntime */
const handlers = new Map<string, Handler>();

export interface LivePurge {
  /** 经 shared/objstore.ts 打同一个后端（和函数里 _shared/gen/objstore.ts 同一份代码） */
  store: ObjStore;
  /** 测试和函数打 S3 的全部请求（两种后端都记） */
  s3Calls: S3Call[];
  /**
   * accountDelete：用这个人的真会话（magiclink 换的 JWT）调 account {action: 'delete'}，要求 200；
   * accountPurge：把 purge_after 改到 1 秒前（冷静期注入成已满），调 account-purge，要求 purged 1、failed 0
   */
  acts: PurgeActs;
  /** 建一个真 Auth 用户（不设密码）和 profile 行；id 不给就随机 */
  mkUser(tag: string, id?: string): Promise<string>;
  userExists(id: string): Promise<boolean>;
  /** 只调 account-purge（带对的 x-cron-secret），要求 200，返回响应体；不判 purged / failed */
  runPurge(): Promise<Record<string, unknown>>;
  /** 最近一次 account-purge 的响应体 */
  lastPurge: Record<string, unknown> | null;
  /** 收件人（Resend 被拦下，不真发） */
  mails: string[];
  /** 经 EdgeRuntime.waitUntil 交来的后台任务个数（account 的第一封信） */
  background(): number;
  /** 等后台任务全部结束 → 清掉本测试的用户和痕迹、还原心跳行 → 还原 Deno、fetch 换成“只许本机”的守卫 → 放锁、断开 */
  close(): Promise<void>;
}

/** S3 替身的凭据（调用方 createFakeS3 用这两个）和地址（不监听端口：fetch 层转给替身；http 只许本机，shared/objstore.ts 认） */
export const LIVE_S3_KEY = 'purge-it-key';
export const LIVE_S3_SECRET = 'purge-it-secret-only-local';
export const LIVE_S3_ENDPOINT = 'http://127.0.0.1:59117';
const LIVE_CRON = 'purge-it-cron-secret-0123456789abcdef-only-local';
const LIVE_EMAIL_LIKE = 'purge-it-%@example.com';
const LIVE_EMAIL_RE = /^purge-it-.*@example\.com$/;

export async function startLivePurge(cfg: LiveSupabase, s3: LiveS3): Promise<LivePurge> {
  if (!isLoopback(cfg.apiUrl) || !isLoopback(cfg.dbUrl)) throw new Error('live purge：只打本机的 Supabase（IT_API_URL / IT_DB_URL 不是本机地址）');
  const [{ default: postgres }, { createClient }, { createObjStore }] = await Promise.all([
    import('postgres'), import('@supabase/supabase-js'), import('../../shared/objstore.ts'),
  ]);
  // ① S3 后端（live-s3.ts）：仓库替身（地址是假的，fetch 层转给它）或真的 S3 兼容实现（LocalStack，请求原样发过去）；两种都记进 s3Calls
  const r = s3Route(s3, { endpoint: LIVE_S3_ENDPOINT, accessKeyId: LIVE_S3_KEY, secretAccessKey: LIVE_S3_SECRET });
  const { base, real } = r;
  const store = createObjStore({ ...r.cfg, fetch: (url, init) => fetch(url, init as RequestInit), now: () => Date.now() });

  // ② fetch：S3 地址交给 s3Route，Resend 拦下，其余只许本机
  const realFetch = globalThis.fetch;
  const guard = loopbackOnlyFetch(realFetch);
  const mails: string[] = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.origin === base) return r.forward(url, input, init, realFetch);
    if (url.origin === 'https://api.resend.com') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { to?: string[] };
      mails.push(...(body.to ?? []));
      return new Response('{"id":"fake"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return guard(input, init);
  }) as typeof fetch;

  // ③ Deno、EdgeRuntime 替身，import 两个 index.ts 拿真处理函数（处理函数每次请求都读 Deno.env，测试期间一直挂着）
  const ENV: Record<string, string> = {
    SUPABASE_URL: cfg.apiUrl, SUPABASE_SERVICE_ROLE_KEY: cfg.serviceKey, RESEND_API_KEY: 're_purge_it_fake', PROXY_SECRET: 'purge-it-proxy',
    CRON_SECRET: LIVE_CRON, SIGNUP_HASH_SECRET: 'purge-it-signup-hash-secret-only-local',
    R2_ENDPOINT: base, R2_FN_ACCESS_KEY_ID: r.cfg.accessKeyId, R2_FN_SECRET_ACCESS_KEY: r.cfg.secretAccessKey, R2_BUCKET_PREFIX: r.cfg.bucketPrefix,
  };
  const g = globalThis as { Deno?: unknown; EdgeRuntime?: unknown };
  const had = { Deno: 'Deno' in g, EdgeRuntime: 'EdgeRuntime' in g };
  const old = { Deno: g.Deno, EdgeRuntime: g.EdgeRuntime };
  const bg: Promise<unknown>[] = [];
  let captured: Handler | null = null;
  g.Deno = {
    env: { get: (k: string) => ENV[k] },
    serve: (h: Handler) => {
      captured = h;
      return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { transport: 'tcp', hostname: '127.0.0.1', port: 0 } };
    },
  };
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => void bg.push(p) };
  /** 还原 Deno、EdgeRuntime；fetch 不还原成原来的，换成“只许本机”的守卫 */
  const restore = () => {
    globalThis.fetch = guard;
    for (const k of ['Deno', 'EdgeRuntime'] as const) if (had[k]) g[k] = old[k]; else delete g[k];
  };
  const grab = async (rel: string): Promise<Handler> => {
    const done = handlers.get(rel);
    if (done) return done;
    captured = null;
    await import(/* @vite-ignore */ rel); // 路径写成变量：tsc 不去查 Deno 源码（npm: 说明符）；相对本文件解析
    const h = captured as Handler | null;
    if (!h) throw new Error(`${rel} 没调 Deno.serve`);
    handlers.set(rel, h);
    return h;
  };
  let accountH: Handler;
  let purgeH: Handler;
  try {
    accountH = await grab('../../supabase/functions/account/index.ts');
    purgeH = await grab('../../supabase/functions/account-purge/index.ts');
  } catch (e) {
    restore();
    throw new Error(`live purge：拿不到 index.ts 的处理函数（先 npm run copy:shared；vitest.config.ts 的 npm: 别名在吗）：${(e as Error).message}`);
  }

  // ④ 库、Auth：连库、拿锁、清上次残留、记下心跳行，任何一步出错都还原 fetch / Deno、放锁、断开
  const sql = postgres(cfg.dbUrl, { max: 3, onnotice: () => {} });
  let lock: Awaited<ReturnType<typeof sql.reserve>> | null = null;
  const admin = createClient(cfg.apiUrl, cfg.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ours: string[] = [];
  const emails = new Map<string, string>();
  const run = crypto.randomUUID().slice(0, 8);
  const userExists = async (id: string) => (await sql`select 1 from auth.users where id = ${id}`).length === 1;
  async function wipe(ids: readonly string[]) {
    if (!ids.length) return;
    for (const id of ids) {
      const error = (await userExists(id)) ? (await admin.auth.admin.deleteUser(id)).error : null;
      if (error) throw new Error(`清理用户失败：${error.message}`);
    }
    await sql`delete from private.deleted_accounts where user_id = any(${ids}::uuid[])`;
    await sql`delete from private.counters where split_part(key, ':', 2) = any(${ids}::text[])`;
  }
  const release = async () => {
    if (lock) {
      await lock`select pg_advisory_unlock(${LIVE_LOCK})`.catch(() => {});
      lock.release();
    }
    await sql.end({ timeout: 5 });
  };
  /** LocalStack 不像替身每次都是空的：只清本测试自己的人（ours）的前缀——mkUser 建好、确认是自己的以后清一次（上次被 kill 的残留），
   *  close 时再清一次（CI 后面 seed.mjs 要求替身里没有 SEED_USERS 的对象）。不碰别人的前缀：别的文件的真替身组也用 SEED_USERS。替身后端什么都不做 */
  const cleanS3 = async (ids: readonly string[]) => { if (real) for (const b of R2_BUCKETS) for (const id of new Set(ids)) await store.deletePrefix(b, `${id}/`); };
  let heartbeat: { at: Date; detail: unknown } | null;
  try {
    lock = await sql.reserve();
    await takeLiveLock(lock);
    const leftovers = (await sql<{ id: string }[]>`select id::text from auth.users where email like ${LIVE_EMAIL_LIKE}`).map((r) => r.id);
    for (const id of [SEED_USERS.a, SEED_USERS.b]) {
      const row = (await sql<{ email: string | null }[]>`select email from auth.users where id = ${id}`)[0];
      if (row && !LIVE_EMAIL_RE.test(row.email ?? '')) throw new Error(`live purge：${id} 已被别的用户占用（邮箱不是 purge-it-*@example.com），不删，请换一个干净的本地库`);
    }
    // 先查完 SEED_USERS 没被别人占（上面），再碰 LocalStack：四个桶各一次 HeadBucket（只读），没起、没建桶都直接提示（B0-117-dev-sugg ③）
    if (real) await headBuckets(r.cfg, R2_BUCKETS, realFetch);
    // B0-117-dev-sugg ①：上次被 kill 时 close 没跑到，purge-it-* 用户在 LocalStack 里的对象还在——先按他们的 id 清前缀，再删人
    //   （删了人以后就不知道这些 id 了；替身组常常先跑，所以替身组设了 OBJSTORE_ENDPOINT 也清）。只清 purge-it-*@example.com 的人
    //   （本测试自己建的），别人的前缀不碰。替身组清不动只提醒；都没设 OBJSTORE_ENDPOINT 时清不了，node build/objstore.mjs down 会连桶一起清掉
    try {
      await sweepRealPrefixes(real ?? realS3Backend((n) => process.env[n]), R2_BUCKETS, leftovers, realFetch);
    } catch (e) {
      if (real) throw e;   // LocalStack 组：清不动就不删人（人删了就不知道这些 id，对象再也清不到），整个开跑失败
      console.warn(`[提醒] live purge：清 LocalStack 里上次残留的对象失败（${(e as Error).message}）；可 node build/objstore.mjs down 一并清掉`);   // 替身组：只提醒，照常删人
    }
    await wipe(leftovers);
    heartbeat = (await sql<{ at: Date; detail: unknown }[]>`select at, detail from private.heartbeat where name = 'account-purge'`)[0] ?? null;
    // 兜底：以前 close 的写法每跑一轮把 detail 多包一层 JSON 字符串（account-purge 写的本是对象）；读到 string 就一层层解开，close 时按原样写回（只碰 account-purge 这一行）
    while (heartbeat && typeof heartbeat.detail === 'string') heartbeat.detail = JSON.parse(heartbeat.detail) as unknown;
  } catch (e) {
    restore();
    await release();
    throw e;
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

  const live: LivePurge = {
    store, s3Calls: r.calls, mails, lastPurge: null, userExists, background: () => bg.length,
    async mkUser(tag, id) {
      const email = `purge-it-${tag}-${run}@example.com`;
      const { data, error } = await admin.auth.admin.createUser({ ...(id ? { id } : {}), email, email_confirm: true });
      if (error || !data.user) throw new Error(`建用户失败：${error?.message}`);
      const uid = data.user.id;
      ours.push(uid);
      if (id) await cleanS3([uid]); // 指定 id（SEED_USERS）的：已确认是本测试建的人，清掉上次被 kill 留下的对象
      emails.set(uid, email);
      await sql`insert into public.profiles (user_id) values (${uid}) on conflict (user_id) do nothing`;
      return uid;
    },
    async runPurge() {
      const others = await sql<{ n: number }[]>`select count(*)::int as n from private.pending_deletions
        where purge_after <= now() + interval '49 hours' and not (user_id = any(${ours}::uuid[]))`;
      if ((others[0]?.n ?? 0) !== 0) throw new Error('本地库里有别人的到期 pending_deletions，不调 account-purge（免得删掉别人的账号）');
      const headers = { 'content-type': 'application/json', 'x-cron-secret': LIVE_CRON };
      const res = await purgeH(new Request('http://127.0.0.1/functions/v1/account-purge', { method: 'POST', headers, body: '{}' }));
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status !== 200) throw new Error(`account-purge 回 ${res.status}：${JSON.stringify(body)}`);
      live.lastPurge = body;
      return body;
    },
    acts: {
      async accountDelete(userId) {
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${await jwtOf(userId)}` };
        const body = JSON.stringify({ action: 'delete', confirm: '注销' });
        const res = await accountH(new Request('http://127.0.0.1/functions/v1/account', { method: 'POST', headers, body }));
        const text = await res.text();
        if (res.status !== 200) throw new Error(`account delete 回 ${res.status}：${text}`);
      },
      async accountPurge(userId) {
        // 冷静期注入成已满：只改 purge_after（其余照 account_request_deletion 写的）
        const upd = await sql`update private.pending_deletions set purge_after = now() - interval '1 second' where user_id = ${userId} returning user_id`;
        if (upd.length !== 1) throw new Error('account-purge 之前 pending_deletions 里没有这个人（account-delete 没生效？）');
        const body = await live.runPurge();
        if (body.purged !== 1 || body.failed !== 0) throw new Error(`account-purge 应该删掉 1 个、失败 0 个：${JSON.stringify(body)}`);
      },
    },
    async close() {
      try {
        await Promise.allSettled(bg); // 后台发信全部结束（期间 Resend 仍被拦）再往下
        const s3Err = await cleanS3(ours).then(() => null, (e: unknown) => e);
        await wipe(ours);
        // sql.json 只序列化一次；以前先 JSON.stringify 再交给 ::jsonb 参数，postgres.js 又序列化一遍，每轮多包一层字符串，越跑越长直到 RangeError
        const back = heartbeat && await sql<{ t: string | null }[]>`update private.heartbeat set at = ${heartbeat.at}, detail = ${heartbeat.detail === null ? null : sql.json(heartbeat.detail as Parameters<typeof sql.json>[0])} where name = 'account-purge' returning jsonb_typeof(detail) as t`;
        if (!heartbeat) await sql`delete from private.heartbeat where name = 'account-purge'`;
        else if (heartbeat.detail !== null && back?.[0]?.t !== 'object') throw new Error(`live purge：还原 account-purge 心跳后 detail 是 ${back?.[0]?.t}，应为 object（被包成字符串了）`);
        if (s3Err) throw new Error(`live purge：收尾清 LocalStack 里的测试对象失败：${(s3Err as Error).message}`);
      } finally {
        restore();
        await release();
      }
    },
  };
  return live;
}
