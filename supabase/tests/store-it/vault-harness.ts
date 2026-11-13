// B5 隐私记 store-it 的准备工作（vault-store.it.ts、vault-move.it.ts 引用；import 本文件即完成准备）：
// 在 harness.ts（只许本机、Resend 替身、R2 用 tests/shared/fake-s3.ts、建用户和真 JWT、残留清单）之上，按真 index.ts 的组装方式拼出
//   vault（core.ts handle + store.ts vaultStore）、vault-image（core.ts handle + store.ts）、account 导出（core.ts handle + index.ts 导出的 makeStore；pin_epoch 用 _shared/vault-epoch.ts）三套处理函数。
// 和线上唯一的不同：数据库事务。线上经 _shared/db.ts 以 fn_vault / fn_ai 登录（ssl: 'require'），本机 lemo-e2e、CI 的库没开 SSL、两个角色也没有密码，
//   所以这里另开一条 prepare: false 的连接（和 db.ts 同样关掉预编译），每个事务：
//     begin → grant <角色> to current_user with set true, inherit false → set local role <角色> → set local statement_timeout → set_config('app.uid')
//     → 跑真 SQL → reset role → revoke <角色> from current_user → commit（出错整个回滚，授权跟着撤掉，不在库里留成员关系）。
//   和 tests/data-manifest/grant-matrix.live.test.ts、supabase/tests/rls/_helpers.psql 同一个切角色办法：表、列授权和会话变量版 RLS 都按 fn_vault / fn_ai 判。
//   真库报的原始错误（core.ts 会归成 503 try_later）记进 dbErrors，断言失败时打出来。
// 钥匙只用测试专用假值（btoa('TEST-ONLY-…') 现算）；推送只记事件，不连外网。
import postgres from 'postgres';
import { AuthError, requireActiveUser } from '../../functions/_shared/auth.ts';
import { envKind } from '../../functions/_shared/env-kind.ts';
import { decodeKey32 } from '../../functions/_shared/vault-crypto.ts';
import { pinEpoch } from '../../functions/_shared/vault-epoch.ts';
import { vaultTokenChecker } from '../../functions/_shared/vault-token.ts';
import { mailLocale, skipTestRecipients, vaultResetMail } from '../../functions/_shared/account-mail.ts';
import { sendMail } from '../../functions/_shared/mail-send.ts';
import type { VaultPushEvent } from '../../functions/_shared/push/payload.ts';
import { createObjStore } from '../../functions/_shared/gen/objstore.ts';
import { tzLabel } from '../../functions/_shared/gen/i18n/tz-label.ts';
import { allManifests } from '../../functions/_shared/gen/manifests/index.ts';
import {
  lockSeconds, PIN_RE, VAULT_FAILS_PER_LEVEL, VAULT_IMAGE_MAX_BYTES, VAULT_RESET_OTP_MAX_AGE_S, vaultImageGet, vaultImageKey,
  vaultImageUploadQuery, vaultRequest, WEBAUTHN_CHALLENGE_TTL_S, WEBAUTHN_RP_ID,
} from '../../functions/_shared/gen/schema/vault.ts';
import type { Deps as VaultDeps, VaultReq } from '../../functions/vault/common.ts';
import { handle as vaultHandle } from '../../functions/vault/core.ts';
import { vaultStore } from '../../functions/vault/store.ts';
import { handle as imageHandle } from '../../functions/vault-image/core.ts';
import { imageMeta, ownsPrivateNote } from '../../functions/vault-image/store.ts';
import { exportTablesOf, handle as accountHandle, withStoreTimeouts } from '../../functions/account/core.ts';
import { admin, assertEquals, fakeS3, s3Server } from './harness.ts';

const accountMod = await import('../../functions/account/index.ts');   // harness.ts 已经换过 Deno.serve 载入过，这里拿缓存的模块
type Tx = postgres.TransactionSql;

// ---------------- 事务：切到 fn_vault / fn_ai ----------------
const DB = Deno.env.get('IT_DB_URL') ?? '';
const API = Deno.env.get('IT_API_URL') ?? '';
export const fnSql = postgres(DB, { prepare: false, max: 1, onnotice: () => {} });
export const dbErrors: string[] = [];

export async function asRole<T>(role: 'fn_vault' | 'fn_ai', uid: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return (await fnSql.begin(async (tx) => {
      await tx.unsafe(`grant ${role} to current_user with set true, inherit false`);
      await tx.unsafe(`set local role ${role}`);
      await tx.unsafe(`set local statement_timeout = '4min'`);
      await tx`select set_config('app.uid', ${uid}, true)`;
      const r = await fn(tx);
      await tx.unsafe('reset role');
      await tx.unsafe(`revoke ${role} from current_user`);
      return r;
    })) as T;
  } catch (e) {
    const x = e as { code?: string; message?: string };
    dbErrors.push(`${role}: ${x.code ?? '-'} ${x.message ?? String(e)}`);
    throw e;
  }
}

/** 503 时把真库的原始错误一起打出来 */
export function expectStatus(got: { status: number; json: Record<string, unknown> | null }, want: number, what: string) {
  const extra = got.status !== want && dbErrors.length ? `；真库错误：${dbErrors.slice(-3).join(' | ')}` : '';
  assertEquals(got.status, want, `${what}（回包 ${JSON.stringify(got.json)}${extra}）`);
}

// ---------------- 钥匙（测试专用假值）、R2、推送替身 ----------------
const k32 = (s: string) => {
  const k = decodeKey32(btoa(s));
  if (!k) throw new Error('测试钥匙不是 32 字节');
  return k;
};
export const KEYS = {
  master: k32('TEST-ONLY-vault-master-key-00000'),
  pepper: k32('TEST-ONLY-vault-pin-pepper-00000'),
  tokenSecret: k32('TEST-ONLY-vault-token-secret-000'),
};
export const r2 = createObjStore({
  endpoint: `http://127.0.0.1:${s3Server.addr.port}`, accessKeyId: 'store-it-key', secretAccessKey: 'store-it-secret', bucketPrefix: '',
  fetch: (url, init) => fetch(url, init as RequestInit), now: () => Date.now(),
});
export const pushes: { user: string; event: VaultPushEvent }[] = [];
export const logs: string[] = [];
const bg: Promise<unknown>[] = [];
/** 等响应之后的后台活（推送、重设邮件、写 logs）做完 */
export async function settle() {
  while (bg.length) await Promise.allSettled(bg.splice(0));
}
const log = (code: string) => { logs.push(code); };
const priv = admin.schema('private');
async function takeRate(k: string, limit: number, windowS: number) {
  const { data, error } = await priv.rpc('take_rate', { p_key: k, p_limit: limit, p_window_s: windowS });
  if (error || typeof data !== 'boolean') throw new Error('db');
  return data;
}

// ---------------- vault（照 vault/index.ts 组装） ----------------
const send = skipTestRecipients((to, mail) => sendMail('re_store_it_fake', to, mail), log);
export const vaultDeps: VaultDeps = {
  async authenticate(r) {
    try {
      const u = await requireActiveUser(r, admin);
      return { ok: true, user: { userId: u.userId, jwt: u.jwt } };
    } catch (e) {
      if (e instanceof AuthError) return { ok: false, response: e.toResponse() };
      throw e;
    }
  },
  parse(v) {
    const p = vaultRequest.safeParse(v);
    return p.success ? (p.data as VaultReq) : null;
  },
  rules: {
    pinRe: PIN_RE, failsPerLevel: VAULT_FAILS_PER_LEVEL, lockSeconds, resetOtpMaxAgeS: VAULT_RESET_OTP_MAX_AGE_S,
    challengeTtlS: WEBAUTHN_CHALLENGE_TTL_S, rpId: WEBAUTHN_RP_ID, imageMaxBytes: VAULT_IMAGE_MAX_BYTES,
    imageKey: vaultImageKey,
  },
  takeRate,
  tx: (uid, fn) => asRole('fn_vault', uid, (sql) => fn(vaultStore(sql as never, uid))),
  keys: KEYS,
  r2,
  env: envKind(API),
  async notify(userId, event) { pushes.push({ user: userId, event }); },
  async resetMail(userId, atMs) {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    const to = data?.user?.email;
    if (error || !to) throw new Error('auth');
    const p = await admin.from('profiles').select('ui_locale, current_tz').eq('user_id', userId).maybeSingle();
    if (p.error) throw new Error('db');
    if (!(await send(to, vaultResetMail(mailLocale(p.data?.ui_locale), atMs, p.data?.current_tz, tzLabel)))) throw new Error('mail');
  },
  async insertLog(userId, row) {
    const { error } = await admin.from('logs').insert({ user_id: userId, t: row.t, kind: 'run', act: row.act, src: 'vault', code: row.code ?? null });
    if (error) throw new Error('db');
  },
  background: (p) => { bg.push(p); },
  now: Date.now,
  log,
};

export const ORIGIN = 'http://localhost:5173';   // 本机环境认的 origin（webauthn-verify.ts）
type Res = { status: number; json: Record<string, unknown> | null };
export async function callVault(jwt: string, body: unknown, token?: string | null): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, origin: ORIGIN };
  if (token) headers['x-vault-token'] = token;
  const res = await vaultHandle(new Request('http://127.0.0.1/functions/v1/vault', { method: 'POST', headers, body: JSON.stringify(body) }), vaultDeps);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
/** 成功的调用：回新令牌 */
export async function okVault(jwt: string, body: unknown, token: string | null, what: string): Promise<Record<string, unknown>> {
  const r = await callVault(jwt, body, token);
  expectStatus(r, 200, what);
  return r.json ?? {};
}

// ---------------- vault-image（照 vault-image/index.ts 组装） ----------------
const imageToken = vaultTokenChecker(KEYS.tokenSecret, Date.now, (uid) => asRole('fn_ai', uid, (tx) => pinEpoch(tx as never, uid)), log);
const imageDeps = {
  async authenticate(r: Request) {
    try {
      return { ok: true as const, user: { userId: (await requireActiveUser(r, admin)).userId } };
    } catch (e) {
      if (e instanceof AuthError) return { ok: false as const, response: e.toResponse() };
      throw e;
    }
  },
  takeRate,
  checkToken: imageToken,
  parseUpload(q: Record<string, string>) {
    const p = vaultImageUploadQuery.safeParse(q);
    return p.success ? p.data : null;
  },
  parseGet(v: unknown) {
    const p = vaultImageGet.safeParse(v);
    return p.success ? p.data : null;
  },
  imageKey: vaultImageKey,
  maxBytes: VAULT_IMAGE_MAX_BYTES,
  ownsPrivateNote: (uid: string, noteId: string) => asRole('fn_ai', uid, (tx) => ownsPrivateNote(tx as never, uid, noteId)),
  image: (uid: string, imageId: string) => asRole('fn_ai', uid, (tx) => imageMeta(tx as never, uid, imageId)),
  r2,
  now: Date.now,
  log,
};
/** 一张最小的“webp”（RIFF????WEBP 文件头 + 几个字节） */
export const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4]);
export async function uploadImage(jwt: string, token: string, noteId: string, imageId: string, part: 'full' | 'thumb' = 'full'): Promise<Res> {
  const q = new URLSearchParams({ action: 'upload', note_id: noteId, image_id: imageId, part });
  const res = await imageHandle(new Request(`http://127.0.0.1/functions/v1/vault-image?${q}`, {
    method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'x-vault-token': token, 'content-type': 'image/webp' }, body: WEBP,
  }), imageDeps);
  return { status: res.status, json: (res.headers.get('content-type') ?? '').startsWith('application/json') ? (await res.json()) as Record<string, unknown> : null };
}
export async function getImage(jwt: string, token: string, imageId: string): Promise<{ status: number; bytes: Uint8Array; type: string | null }> {
  const res = await imageHandle(new Request('http://127.0.0.1/functions/v1/vault-image', {
    method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'x-vault-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'get', image_id: imageId }),
  }), imageDeps);
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') };
}

// ---------------- account 导出（照 account/index.ts 组装，令牌经 fn_vault 读 pin_epoch） ----------------
const accountToken = vaultTokenChecker(KEYS.tokenSecret, Date.now, (uid) => asRole('fn_vault', uid, (tx) => pinEpoch(tx as never, uid)), log);
const accountDeps = {
  async authenticate(r: Request, opts: { allowPendingDeletion: boolean }) {
    try {
      return { ok: true as const, user: await requireActiveUser(r, admin, opts) };
    } catch (e) {
      if (e instanceof AuthError) return { ok: false as const, response: e.toResponse(), code: e.code };
      throw e;
    }
  },
  store: withStoreTimeouts((signal) => accountMod.makeStore(admin, signal), { log }),
  async userEmail() { return null; },
  async sendMail() { return true; },
  tzLabel,
  verifyVaultToken: async (userId: string, token: string) => (await accountToken(userId, token)).verdict,
  async checkVersion() { return null; },
  exportTables: exportTablesOf(allManifests),
  proxySecret: undefined,
  background: (p: Promise<unknown>) => { bg.push(p); },
  now: Date.now,
  log,
};
/** 带隐私记令牌导出一次（start → part … done），回整份 JSON */
export async function exportWithToken(jwt: string, token: string | null): Promise<Record<string, unknown>> {
  const call = async (body: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${jwt}` };
    if (token) headers['x-vault-token'] = token;
    // deno-lint-ignore no-explicit-any
    return await accountHandle(new Request('http://127.0.0.1/functions/v1/account', { method: 'POST', headers, body: JSON.stringify(body) }), accountDeps as any);
  };
  const s = await call({ action: 'export', step: 'start' });
  const sj = (await s.json()) as Record<string, unknown>;
  assertEquals(s.status, 200, `导出 start：${JSON.stringify(sj)}；真库错误：${dbErrors.slice(-3).join(' | ')}`);
  let cursor: string | null = null;
  let raw = '';
  for (let i = 0; i < 20; i++) {
    const r = await call({ action: 'export', step: 'part', export_id: sj.export_id, cursor });
    assertEquals(r.status, 200, `导出 part：${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    raw += await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const next = r.headers.get('x-lemo-export-next') ?? '';
    if (next === 'done') return JSON.parse(raw) as Record<string, unknown>;
    cursor = next;
  }
  throw new Error('20 片还没取完');
}

/** R2 替身里放一个对象（字节可指定） */
export const s3PutBytes = (bucket: string, key: string, body: Uint8Array) =>
  fakeS3.objects.set(`${bucket}/${key}`, { body, contentType: 'image/webp', etag: '"e"' });

/** 收尾：关本文件开的连接 */
export async function closeVaultHarness() {
  await settle();
  await fnSql.end({ timeout: 5 });
}
