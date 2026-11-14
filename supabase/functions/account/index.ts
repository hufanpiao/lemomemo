// account 入口（架构第 6 节函数表 account、“account delete”、“account-purge 怎么执行”的时序 1、2；R-185、R-188、R-192）。
// 逻辑和测试见 core.ts、tests/functions/account.test.ts。
// status 只用 requireActiveUser（冷静期放行，不碰 store）；其余经 supabase-js（service role）：rpc private.account_request_deletion / account_restore / take_rate（20261029150000、20261029130000），
//   读 private.admins、public.profiles、public.devices，写 public.logs，读 export: json 的 public 表；
//   导出失败时退回当天的一次：读、改 private.counters（比较并交换）；Auth 管理接口 getUserById。
//   导出分片（0.47 续 ①）：rpc private.export_size_over / export_job_start / export_job_take（20261031100000）；
//   读 counters（预检前只读查当天次数）、删 counters 的任务行（start 退回时，N2）；part 取片前读 logs 的发起记录（0.47 第 22 条 T2）。
// store 的每次调用都带超时（store-timeout.ts：默认 10 秒，export_size_over 20 秒；0.47 第 22 条）。
// restore、delete 用 service role 调 definer 函数（0.38 第 45 条），不用 fn_vault。
// 现在不直连数据库、不碰 R2（第 6 节名单里 account 可以用 fn_vault 和 R2，B5 接隐私记导出时再看要不要）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）；RESEND_API_KEY、PROXY_SECRET（8.4）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { background } from '../_shared/background.ts';
import { allManifests } from '../_shared/gen/manifests/index.ts';
import { ACCOUNT_ERROR_CODES } from '../_shared/gen/schema/account.ts';
import { tzLabel } from '../_shared/gen/i18n/tz-label.ts';
import { skipTestRecipients } from '../_shared/account-mail.ts';
import { ACCOUNT_ERRS, DbError, exportTablesOf, handle, memProbeFor, withStoreTimeouts, type AccountStore } from './core.ts';
import { json } from '../_shared/http.ts';
import { sendMail } from '../_shared/mail-send.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_SIZE_TIMEOUT_MS } from './store-timeout.ts';
import { withVaultUser } from '../_shared/db.ts';
import { decodeKey32 } from '../_shared/vault-crypto.ts';
import { pinEpoch } from '../_shared/vault-epoch.ts';
import { vaultTokenChecker } from '../_shared/vault-token.ts';
import { cachedMinClientVersion } from '../_shared/version-gate.ts';
import { blockedMin, upgradeRequiredResponse, VERSION_HEADER } from '../_shared/version-gate-core.ts';

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

/** signal：这一次调用的超时（store-timeout.ts 每次调用新建一个 AbortController）；每条查询都挂上 .abortSignal(signal) */
/** 线上的 store（service role 的 supabase-js）；导出给 store-it（vault-store.it.ts 带隐私记令牌导出时自己组装 deps） */
export function makeStore(admin: Admin, signal: AbortSignal): AccountStore {
  const priv = admin.schema('private');
  return {
    async isAdmin(userId) {
      const row = must(await priv.from('admins').select('user_id').eq('user_id', userId).abortSignal(signal).maybeSingle());
      return row !== null;
    },
    takeRate: rpcTakeRate(admin, signal),
    async refundRate(key) {
      // 键最新窗口的 count 减 1：先读再比较并交换（并发时重试 3 次）；service role 对 counters 有 select、update（0001 第 18 节）
      const counters = () => priv.from('counters');
      for (let i = 0; i < 3; i++) {
        const row = must(await counters().select('window_start, count').eq('key', key).order('window_start', { ascending: false }).limit(1)
          .abortSignal(signal).maybeSingle()) as { window_start: string; count: number } | null;
        if (!row || typeof row.count !== 'number' || row.count <= 0) return;
        const upd = must(await counters().update({ count: row.count - 1 }).eq('key', key).eq('window_start', row.window_start)
          .eq('count', row.count).select('key').abortSignal(signal));
        if (Array.isArray(upd) && upd.length === 1) return;
      }
      throw new Error('refund_contended');
    },
    async peekRate(key) {
      // 只读：这个键最新窗口的 count（start 预检前查当天导出次数，0.47 第 19 条 Q1）
      const row = must(await priv.from('counters').select('count').eq('key', key).order('window_start', { ascending: false }).limit(1)
        .abortSignal(signal).maybeSingle()) as { count: number } | null;
      if (row !== null && typeof row.count !== 'number') throw new Error('db');
      return row?.count ?? 0;
    },
    async deleteCounterKey(key) {
      must(await priv.from('counters').delete().eq('key', key).abortSignal(signal));
    },
    async exportSizeOver(userId, mode, limit, budgetMs) {
      const data = must(await priv.rpc('export_size_over', { p_user: userId, p_mode: mode, p_limit: limit, p_budget_ms: budgetMs }).abortSignal(signal));
      if (typeof data !== 'number' || !Number.isSafeInteger(data)) throw new Error('db');
      return data;
    },
    async exportJobStart(userId, exportId, mode, sessionId) {
      const { data, error } = await priv.rpc('export_job_start', { p_user: userId, p_export_id: exportId, p_mode: mode, p_session: sessionId }).abortSignal(signal);
      if (error) {
        // 同名任务行已存在（迁移里 raise 'export_job_exists' using errcode 23505）：单独报出来，export.ts 的 fail() 不删那一行（TC-B1-138 ⑥）
        const e = error as { code?: unknown; message?: unknown };
        if (e.code === '23505' || e.message === 'export_job_exists') throw new DbError('export_job_exists');
        throw new Error('db');
      }
      if (typeof data !== 'string') throw new Error('db');
      return data;
    },
    async exportJobTake(userId, exportId, mode, sessionId, maxParts, ttlS) {
      const rows = must(await priv.rpc('export_job_take', {
        p_user: userId, p_export_id: exportId, p_mode: mode, p_session: sessionId, p_max: maxParts, p_ttl_s: ttlS,
      }).abortSignal(signal)) as unknown;
      const row = Array.isArray(rows) && rows.length === 1 ? (rows[0] as { verdict?: unknown; started_at?: unknown; parts?: unknown }) : null;
      if (!row || (row.verdict !== 'ok' && row.verdict !== 'expired' && row.verdict !== 'too_many')) throw new Error('db');
      return {
        verdict: row.verdict,
        startedAt: typeof row.started_at === 'string' ? row.started_at : null,
        parts: typeof row.parts === 'number' ? row.parts : null,
      };
    },
    async requestDeletion(userId) {
      const { data, error } = await priv.rpc('account_request_deletion', { p_user: userId }).abortSignal(signal);
      if (error) {
        const msg = (error as { message?: unknown }).message;
        if (typeof msg === 'string' && RPC_CODES.has(msg)) throw new DbError(msg);
        throw new Error('db');
      }
      if (typeof data !== 'string') throw new Error('db');
      return data;
    },
    async restore(userId) {
      const data = must(await priv.rpc('account_restore', { p_user: userId }).abortSignal(signal));
      if (typeof data !== 'string') throw new Error('db');
      return data;
    },
    async profile(userId) {
      return must(await admin.from('profiles').select('ui_locale, current_tz').eq('user_id', userId).abortSignal(signal).maybeSingle());
    },
    async deviceLabel(userId, deviceId) {
      const row = must(await admin.from('devices').select('label, platform').eq('id', deviceId).eq('user_id', userId).abortSignal(signal).maybeSingle()) as
        { label: string | null; platform: string | null } | null;
      return row ? { label: row.label ?? null, platform: row.platform ?? null } : null;
    },
    async insertLog(userId, row) {
      must(await admin.from('logs').insert({ user_id: userId, ...row }).abortSignal(signal));
    },
    async exportDoneLogged(userId, exportId) {
      const rows = must(await admin.from('logs').select('id').eq('user_id', userId).eq('src', 'account').eq('act', 'export_done')
        .eq('code', exportId).limit(1).abortSignal(signal));
      return Array.isArray(rows) && rows.length > 0;
    },
    async exportStarted(userId, exportId) {
      // 0.47 第 22 条 T2：四个条件都在索引 logs_account_export_idx (user_id, act, src, code) 里（PostgREST 参数化的通用计划也用得上）
      const rows = must(await admin.from('logs').select('id').eq('user_id', userId).eq('act', 'export').eq('src', 'account')
        .eq('code', exportId).limit(1).abortSignal(signal));
      return Array.isArray(rows) && rows.length > 0;
    },
    async readPage(table, keyCol, userId, after, limit) {
      // 按主键往后翻页（gt），不用 offset；keyCol 由 core.ts 的 exportTablesOf 给（profiles 是 user_id，其余是 id）
      const base = admin.from(table).select('*').eq('user_id', userId);
      const q = after === null ? base : base.gt(keyCol, after);
      const rows = must(await q.order(keyCol, { ascending: true }).limit(limit).abortSignal(signal));
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    },
    async rebindDevice(userId, deviceId, oldSession, newSession) {
      // 必须经 PostgREST 的 rpc（service role），rebind_device_impl 里的 devices_session_guard() 才认（0.29 续第 112、119 条）；错误内容不看、不记
      const { error } = await priv.rpc('rebind_device_impl', { p_user: userId, p_device: deviceId, p_old_session: oldSession, p_new_session: newSession })
        .abortSignal(signal);
      if (!error) return;
      // raise exception 的业务拒绝是 P0001（session_revoked、device_mismatch 等），bad_rebind 是 22023；连不上、超时之类照抛 db（回 try_later）
      const code = (error as { code?: unknown }).code;
      if (code === 'P0001' || code === '22023') throw new DbError('rebind_failed');
      throw new Error('db');
    },
    async deviceSession(userId, deviceId) {
      const row = must(await admin.from('devices').select('session_id').eq('id', deviceId).eq('user_id', userId).abortSignal(signal).maybeSingle()) as
        { session_id: string | null } | null;
      return row?.session_id ?? null;
    },
  };
}

const log = (code: string) => console.error(`account: ${code}`);
// 导出内存探针：EXPORT_MEM_PROBE=1 且本机才开；线上误设只在模块加载时记一次 mem_probe_ignored（安全审查 K1）
const memProbe = memProbeFor(Deno.env.get('EXPORT_MEM_PROBE'), Deno.env.get('SUPABASE_URL'), () => {
  const m = Deno.memoryUsage();
  return { heap: m.heapUsed, total: m.heapUsed + m.external };
}, log);

/** 函数日志里认人用的 user_id 哈希（sha256 前 16 位十六进制，0.47 第 19 条 Q4）：日志里不出现 user_id 原文 */
async function userHash(userId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId)));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const EXPORT_TABLES = exportTablesOf(allManifests);
// 本人的 pin_epoch 经 fn_vault 读（SQL 在 _shared/vault-epoch.ts，和 vault-image 共用）
const checkVaultToken = vaultTokenChecker(decodeKey32(Deno.env.get('VAULT_TOKEN_SECRET')), Date.now, (uid) => withVaultUser(uid, (tx) => pinEpoch(tx, uid)), log);
// 错误码以 shared/schema/account.ts 为准（0.38 第 48 条）；core.ts 自己那份对不上就记日志（单测已核对，这里防生成目录过期）
//   整串比较、不按下标取：CI 的 unit 任务跑 check_backend 前不生成 gen/，类型推不出来时 F7 不认回调参数当下标（错误码里没有逗号）
if (ACCOUNT_ERRS.join(',') !== ACCOUNT_ERROR_CODES.join(',')) log('error_codes_drift');

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!url || !key || !resendKey) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  // 每个请求的上限取最长那一档（export_size_over 20 秒），不抢在 store-timeout.ts 的按调用计时前面
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_SIZE_TIMEOUT_MS) } });
  return handle(req, {
    authenticate: (r, opts) => authResult(() => requireActiveUser(r, admin, opts)),
    // 每个方法默认 10 秒、export_size_over 20 秒超时（0.47 第 22 条），超时只记 store_timeout:<方法名>
    store: withStoreTimeouts((signal) => makeStore(admin, signal), { log }),
    async userEmail(userId) {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error) throw new Error('auth');
      return data.user?.email ?? null;
    },
    sendMail: skipTestRecipients((to, mail) => sendMail(resendKey, to, mail), log),   // @lemomemo.test 不真发（安全审查 D1）
    tzLabel,   // 邮件里时区的通俗说法，和 App 恢复页同一份（shared/i18n/tz-label.ts，KO-mail-nolink-tz）
    // 隐私记的令牌（vault_token）由 vault 函数签发，这里经 _shared/vault-token.ts 验（6.2 A2；B5 任务单 S10）：pin_epoch 经 fn_vault 读；
    // 没配 VAULT_TOKEN_SECRET 时带了令牌一律 vault_locked，并记 misconfigured:vault_token_secret（不带令牌照常导出）
    verifyVaultToken: async (userId, token) => (await checkVaultToken(userId, token)).verdict,
    async checkVersion(r) {
      const min = await cachedMinClientVersion(async (signal) => {
        const { data, error } = await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle();
        if (error) throw new Error('db');
        return data?.min_client_version ?? null;
      });
      const b = blockedMin(min, r.headers.get(VERSION_HEADER));
      return b === null ? null : upgradeRequiredResponse(b);
    },
    exportTables: EXPORT_TABLES,
    userHash,
    memProbe,
    proxySecret: Deno.env.get('PROXY_SECRET'),
    background,
    now: Date.now,
    log,
  });
});
