// account 入口（架构第 6 节函数表 account、“account delete”、“account-purge 怎么执行”的时序 1、2；R-185、R-188、R-192）。
// 逻辑和测试见 core.ts、tests/functions/account.test.ts。
// 经 supabase-js（service role）：rpc private.account_request_deletion / account_restore / take_rate（20261029150000、20261029130000），
//   读 private.admins、public.profiles、public.devices，写 public.logs，读 export: json 的 public 表；
//   导出失败时退回当天的一次：读、改 private.counters（比较并交换）；Auth 管理接口 getUserById。
// restore、delete 用 service role 调 definer 函数（0.38 第 45 条），不用 fn_vault。
// 现在不直连数据库、不碰 R2（第 6 节名单里 account 可以用 fn_vault 和 R2，B5 接隐私记导出时再看要不要）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）；RESEND_API_KEY、PROXY_SECRET（8.4）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AuthError, requireActiveUser } from '../_shared/auth.ts';
import { allManifests } from '../_shared/gen/manifests/index.ts';
import { ACCOUNT_ERROR_CODES } from '../_shared/gen/schema/account.ts';
import type { Mail } from '../_shared/account-mail.ts';
import { ACCOUNT_ERRS, DbError, exportTablesOf, handle, type AccountStore } from './core.ts';

const RESEND_URL = 'https://api.resend.com/emails';
const MAIL_FROM = '柠檬记 <noreply@lemomemo.com>';   // 5.6：发件人 noreply@lemomemo.com（和 invite-signup 同一个）
const NET_TIMEOUT_MS = 8000;
/** rpc 抛出的业务错误（raise exception '<码>'），原样当错误码 */
const RPC_CODES = new Set(['admin_cannot_delete', 'account_disabled', 'account_pending_deletion']);

// 没有生成的库类型：按 _shared/auth.ts 的写法用不带泛型的 SupabaseClient（行一律当 any，返回值逐个收窄）
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw new Error('db');
  return r.data;
}

function makeStore(admin: Admin): AccountStore {
  const priv = admin.schema('private');
  return {
    async isAdmin(userId) {
      const row = must(await priv.from('admins').select('user_id').eq('user_id', userId).maybeSingle());
      return row !== null;
    },
    async takeRate(key, limit, windowS) {
      const data = must(await priv.rpc('take_rate', { p_key: key, p_limit: limit, p_window_s: windowS }));
      if (typeof data !== 'boolean') throw new Error('db');
      return data;
    },
    async refundRate(key) {
      // 键最新窗口的 count 减 1：先读再比较并交换（并发时重试 3 次）；service role 对 counters 有 select、update（0001 第 18 节）
      const counters = () => priv.from('counters');
      for (let i = 0; i < 3; i++) {
        const row = must(await counters().select('window_start, count').eq('key', key).order('window_start', { ascending: false }).limit(1)
          .maybeSingle()) as { window_start: string; count: number } | null;
        if (!row || typeof row.count !== 'number' || row.count <= 0) return;
        const upd = must(await counters().update({ count: row.count - 1 }).eq('key', key).eq('window_start', row.window_start)
          .eq('count', row.count).select('key'));
        if (Array.isArray(upd) && upd.length === 1) return;
      }
      throw new Error('refund_contended');
    },
    async requestDeletion(userId) {
      const { data, error } = await priv.rpc('account_request_deletion', { p_user: userId });
      if (error) {
        const msg = (error as { message?: unknown }).message;
        if (typeof msg === 'string' && RPC_CODES.has(msg)) throw new DbError(msg);
        throw new Error('db');
      }
      if (typeof data !== 'string') throw new Error('db');
      return data;
    },
    async restore(userId) {
      const data = must(await priv.rpc('account_restore', { p_user: userId }));
      if (typeof data !== 'string') throw new Error('db');
      return data;
    },
    async profile(userId) {
      return must(await admin.from('profiles').select('ui_locale, current_tz').eq('user_id', userId).maybeSingle());
    },
    async deviceLabel(userId, deviceId) {
      const row = must(await admin.from('devices').select('label').eq('id', deviceId).eq('user_id', userId).maybeSingle()) as { label: string | null } | null;
      return row?.label ?? null;
    },
    async insertLog(userId, row) {
      must(await admin.from('logs').insert({ user_id: userId, ...row }));
    },
    async readPage(table, keyCol, userId, after, limit) {
      // 按主键往后翻页（gt），不用 offset；keyCol 由 core.ts 的 exportTablesOf 给（profiles 是 user_id，其余是 id）
      const base = admin.from(table).select('*').eq('user_id', userId);
      const q = after === null ? base : base.gt(keyCol, after);
      const rows = must(await q.order(keyCol, { ascending: true }).limit(limit));
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    },
  };
}

async function postWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, redirect: 'error' });
  } finally {
    clearTimeout(t);
  }
}

async function sendMail(apiKey: string, to: string, mail: Mail): Promise<boolean> {
  const r = await postWithTimeout(RESEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: mail.subject, text: mail.text }),
  });
  await r.body?.cancel();
  return r.ok;
}

/** Supabase Edge Runtime 自带的全局（本机 deno 里没有，用 typeof 判断） */
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** 响应之后继续跑（EdgeRuntime.waitUntil；没有时就让它自己跑完） */
function background(p: Promise<unknown>): void {
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime) EdgeRuntime.waitUntil(p);
  else p.catch(() => {});
}

const log = (code: string) => console.error(`account: ${code}`);
const EXPORT_TABLES = exportTablesOf(allManifests);
// 错误码以 shared/schema/account.ts 为准（0.38 第 48 条）；core.ts 自己那份对不上就记日志（单测已核对，这里防生成目录过期）
//   整串比较、不按下标取：CI 的 unit 任务跑 check_backend 前不生成 gen/，类型推不出来时 F7 不认回调参数当下标（错误码里没有逗号）
if (ACCOUNT_ERRS.join(',') !== ACCOUNT_ERROR_CODES.join(',')) log('error_codes_drift');

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!url || !key || !resendKey) {
    log('misconfigured');
    return new Response(JSON.stringify({ error: 'misconfigured' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return handle(req, {
    async authenticate(r, opts) {
      try {
        return { ok: true, user: await requireActiveUser(r, admin, opts) };
      } catch (e) {
        if (e instanceof AuthError) return { ok: false, response: e.toResponse({ 'cache-control': 'no-store' }) };
        throw e;
      }
    },
    store: makeStore(admin),
    async userEmail(userId) {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error) throw new Error('auth');
      return data.user?.email ?? null;
    },
    sendMail: (to, mail) => sendMail(resendKey, to, mail),
    // 隐私记的令牌（vault_token）由 B5 的 vault 函数签发、_shared/vault-token.ts 验（6.2 A2）；B1 还没有这两样，
    // 所以现在没有任何有效令牌：带了令牌的导出一律回 vault_locked（不静默少一块），B5 接上 verifyVaultToken。
    verifyVaultToken: async () => 'vault_locked',
    exportTables: EXPORT_TABLES,
    proxySecret: Deno.env.get('PROXY_SECRET'),
    background,
    now: Date.now,
    log,
  });
});
