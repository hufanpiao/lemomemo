// push-dispatch 入口（架构 5.3、第 6 节）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每分钟由 pg_cron 经 pg_net 调一次（迁移 20261103120000_core_push_dispatch_cron.sql，timeout 25000 ms、带 x-region）。
// 逻辑和测试见 core.ts、tests/functions/push-dispatch.test.ts；推送的加密、签名、发送在 _shared/push/（push-test 共用）。
// 数据库只经 supabase-js（service role）：private.heartbeat、private.account_usable（经 _shared/auth.ts）；BE-2 再加 remind_queue、
//   events / todos / anniversaries、devices、profiles、settings、logs。不用 fn_vault、不直连数据库（不 import _shared/db.ts）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）；CRON_SECRET；VAPID_PRIVATE_KEY（JWK）、VAPID_PUBLIC_KEY、VAPID_SUBJECT（O-1 脚本写）；
//   PUSH_SERVICE_OVERRIDE_URL、LEMO_LOCAL_PUSH_STUB（只给本机推送替身，D1-8；线上设了替身就回 500 misconfigured）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { resolveOverride } from '../_shared/push/stub.ts';
import { loadVapid, type VapidLoad } from '../_shared/push/vapid.ts';
import { HEARTBEAT, handle, type DispatchStore } from './core.ts';

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function makeStore(admin: Admin): DispatchStore {
  return {
    async writeHeartbeat(detail) {
      const { error } = await admin.schema('private').from('heartbeat').upsert({ name: HEARTBEAT, at: new Date().toISOString(), detail }, { onConflict: 'name' });
      if (error) throw new Error('db');
    },
  };
}

// 每个实例只自检一次（C-9）；三个变量的值变了（换钥匙后重新部署会起新实例，这里只是兜底）就重做
// 三个值整串比较（代码审查 S10；值只在内存里，不写日志）。BE-2 接发送时 VapidSigner 跟着这份缓存走：缓存换了才新建 signer，
// 同一实例跨轮复用，“同一 origin 签一次”才成立
let vapidMemo: { priv: string | undefined; pub: string | undefined; sub: string | undefined; p: Promise<VapidLoad> } | null = null;
function vapidOnce(priv: string | undefined, pub: string | undefined, sub: string | undefined): Promise<VapidLoad> {
  if (!vapidMemo || vapidMemo.priv !== priv || vapidMemo.pub !== pub || vapidMemo.sub !== sub) vapidMemo = { priv, pub, sub, p: loadVapid(priv, pub, sub) };
  return vapidMemo.p;
}

const log = (code: string) => console.error(`push-dispatch: ${code}`);

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  return handle(req, {
    cronSecret: Deno.env.get('CRON_SECRET'),
    override: resolveOverride(Deno.env.get('PUSH_SERVICE_OVERRIDE_URL'), url, Deno.env.get('LEMO_LOCAL_PUSH_STUB')),
    vapid: () => vapidOnce(Deno.env.get('VAPID_PRIVATE_KEY'), Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_SUBJECT')),
    store: admin ? makeStore(admin) : null,
    async isUsable(userId) {
      if (!admin) throw new Error('misconfigured');
      return (await isUsable(admin, userId)).ok;
    },
    now: Date.now,
    log,
  });
});
