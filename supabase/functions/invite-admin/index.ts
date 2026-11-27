// invite-admin 入口（架构 5.6 发码、第 6 节函数表 invite-admin、3.3 F；R-83：只有管理员能发码）。
// 逻辑和测试见 core.ts、tests/functions/invite-admin.test.ts。
// 经 supabase-js（service role）：读 private.admins，写、读、改（revoke 改 expires_at）private.invites，rpc private.take_rate（0.29 续第 52 条：经 schema('private')），
//   读 app_config（版本门）；不直连数据库（不 import _shared/db.ts，不在 6.2 的名单里），不碰 R2。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { serviceAdmin } from '../_shared/admin.ts';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { isAdmin } from '../_shared/user-reads.ts';
import { appConfigMinLoader, cachedMinClientVersion } from '../_shared/version-gate.ts';
import { INVITE_ADMIN_ERROR_CODES } from '../_shared/gen/schema/invite-admin.ts';
import { handle, INVITE_ADMIN_ERRS, type InviteStore } from './core.ts';
import { withStoreTimeouts } from './store-timeout.ts';
import { codeLogger } from '../_shared/fn-log.ts';

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
    isAdmin: (userId) => isAdmin(admin, userId, signal),
    takeRate: rpcTakeRate(admin, signal),
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
      const rows = must(await priv.from('invites').select('code_hash, note, max_uses, used_count, expires_at')
        .eq('created_by', createdBy).gt('expires_at', notExpiredAt).order('expires_at', { ascending: false }).limit(limit).abortSignal(signal));
      return Array.isArray(rows) ? rows : [];
    },
    // idPrefix 由 core.ts 核过只有 8 或 16 位小写十六进制，拼进 like 不会带通配符
    async findLiveInvites(createdBy, idPrefix, notExpiredAt, limit) {
      const rows = must(await priv.from('invites').select('code_hash, max_uses, used_count')
        .eq('created_by', createdBy).like('code_hash', `${idPrefix}%`).gt('expires_at', notExpiredAt).limit(limit).abortSignal(signal));
      return Array.isArray(rows) ? rows : [];
    },
    // 比较并交换：PostgREST 的过滤不能拿两列比（写不出 used_count < max_uses，同 5.6 占码的写法），按读到的 used_count 原值比；
    //   和 invite_claim 的 update 撞上时行锁排队，后到的一方按新值重判条件：先占上的，这里改到 0 行；先作废的，那边 expires_at 不再大于 p_now
    async expireInvite(codeHash, createdBy, usedCount, notExpiredAt, expiresAt) {
      const rows = must(await priv.from('invites').update({ expires_at: expiresAt })
        .eq('code_hash', codeHash).eq('created_by', createdBy).eq('used_count', usedCount).gt('expires_at', notExpiredAt)
        .select('code_hash').abortSignal(signal));
      return Array.isArray(rows) && rows.length === 1;
    },
    // 架构 0.38 第 52 条：经函数侧版本门的缓存读（超时 1.5 秒、成功缓存 60 秒、失败缓存 10 秒放行）
    minClientVersion() {
      return cachedMinClientVersion(appConfigMinLoader(admin));
    },
  };
}

const log = codeLogger('invite-admin');
// 错误码以 shared/schema/invite-admin.ts 为准；core.ts 自己那份对不上就记日志（单测已核对，这里防生成目录过期）。整串比较、不按下标取（同 account）
if (INVITE_ADMIN_ERRS.join(',') !== INVITE_ADMIN_ERROR_CODES.join(',')) log('error_codes_drift');

Deno.serve((req) => {
  const admin = serviceAdmin(log);
  if (admin instanceof Response) return admin;
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    store: withStoreTimeouts((signal) => makeStore(admin, signal), { log }),
    now: Date.now,
    log,
  });
});
