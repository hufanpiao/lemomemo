// invite-admin 入口（架构 5.6 发码、第 6 节函数表 invite-admin、3.3 F；R-83：只有管理员能发码）。
// 逻辑和测试见 core.ts、tests/functions/invite-admin.test.ts。
// 经 supabase-js（service role）：读 private.admins，写、读 private.invites，rpc private.take_rate（0.29 续第 52 条：经 schema('private')），
//   读 app_config（版本门）；不直连数据库（不 import _shared/db.ts，不在 6.2 的名单里），不碰 R2。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AuthError, requireActiveUser } from '../_shared/auth.ts';
import { cachedMinClientVersion } from '../_shared/version-gate.ts';
import { INVITE_ADMIN_ERROR_CODES } from '../_shared/gen/schema/invite-admin.ts';
import { handle, INVITE_ADMIN_ERRS, type InviteStore } from './core.ts';
import { withStoreTimeouts } from './store-timeout.ts';

// 没有生成的库类型：按 _shared/auth.ts 的写法用不带泛型的 SupabaseClient（行一律当 any，返回值逐个收窄）
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw new Error('db');
  return r.data;
}

// 导出给 supabase/tests/store-it/invite-admin-store.it.ts 直接打本机真库（同 account-purge；那边不传 signal，等于不设超时）。
// 线上每次 store 调用由 store-timeout.ts 新建一个 signal 交进来，各查询挂 .abortSignal(signal)（INVITE-store-timeout）
export function makeStore(admin: Admin, signal: AbortSignal = new AbortController().signal): InviteStore {
  const priv = admin.schema('private');
  return {
    async isAdmin(userId) {
      const row = must(await priv.from('admins').select('user_id').eq('user_id', userId).abortSignal(signal).maybeSingle());
      return row !== null;
    },
    async takeRate(key, limit, windowS) {
      const data = must(await priv.rpc('take_rate', { p_key: key, p_limit: limit, p_window_s: windowS }).abortSignal(signal));
      if (typeof data !== 'boolean') throw new Error('db');
      return data;
    },
    async insertInvite(row) {
      const { error } = await priv.from('invites').insert(row).abortSignal(signal);
      if (!error) return 'ok';
      // 23505 而且是主键 invites_pkey（code_hash）冲突：换一个码重来；别的唯一约束冲突、其余错误一律当数据库出错
      //（PostgREST 把约束名放在 message 里：duplicate key value violates unique constraint "invites_pkey"）
      const e = error as { code?: unknown; message?: unknown };
      if (e.code === '23505' && typeof e.message === 'string' && e.message.includes('"invites_pkey"')) return 'duplicate';
      throw new Error('db');
    },
    async listInvites(createdBy, notExpiredAt, limit) {
      const rows = must(await priv.from('invites').select('note, max_uses, used_count, expires_at')
        .eq('created_by', createdBy).gt('expires_at', notExpiredAt).order('expires_at', { ascending: false }).limit(limit).abortSignal(signal));
      return Array.isArray(rows) ? rows : [];
    },
    // 架构 0.38 第 52 条：经函数侧版本门的缓存读（超时 1.5 秒、成功缓存 60 秒、失败缓存 10 秒放行）
    minClientVersion() {
      return cachedMinClientVersion(async (signal) => {
        const row = must(await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle()) as { min_client_version: string | null } | null;
        return row?.min_client_version ?? null;
      });
    },
  };
}

const log = (code: string) => console.error(`invite-admin: ${code}`);
// 错误码以 shared/schema/invite-admin.ts 为准；core.ts 自己那份对不上就记日志（单测已核对，这里防生成目录过期）。整串比较、不按下标取（同 account）
if (INVITE_ADMIN_ERRS.join(',') !== INVITE_ADMIN_ERROR_CODES.join(',')) log('error_codes_drift');

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return new Response(JSON.stringify({ error: 'misconfigured' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return handle(req, {
    async authenticate(r) {
      try {
        return { ok: true, user: await requireActiveUser(r, admin) };
      } catch (e) {
        if (e instanceof AuthError) return { ok: false, response: e.toResponse({ 'cache-control': 'no-store' }) };
        throw e;
      }
    },
    store: withStoreTimeouts((signal) => makeStore(admin, signal), { log }),
    now: Date.now,
    log,
  });
});
