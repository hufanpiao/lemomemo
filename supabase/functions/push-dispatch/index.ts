// push-dispatch 入口（架构 5.3、第 6 节）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每分钟由 pg_cron 经 pg_net 调一次（迁移 20261103120000_core_push_dispatch_cron.sql，timeout 25000 ms、带 x-region）。
// 逻辑和测试见 core.ts、tests/functions/push-dispatch.test.ts；推送的加密、签名、发送在 _shared/push/（push-test 共用）。
// 数据库只经 supabase-js（service role，store.ts）：private.heartbeat、private.remind_queue（经 private.remind_queue_pop，迁移 20261103130000）、
//   private.account_usable（经 _shared/auth.ts）、events / todos / anniversaries、devices、profiles、settings、logs。不用 fn_vault、不直连数据库（不 import _shared/db.ts）。
// 共享 logic 从 _shared/gen（build/copy_shared.mjs 生成）接进 core.ts：remindAtOf、dndDeferUntil、notify-text、t、isValidTz、msAt。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）；CRON_SECRET；VAPID_PRIVATE_KEY（JWK）、VAPID_PUBLIC_KEY、VAPID_SUBJECT（O-1 脚本写）；
//   PUSH_SERVICE_OVERRIDE_URL、LEMO_LOCAL_PUSH_STUB（只给本机推送替身，D1-8；线上设了替身就回 500 misconfigured）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { msAt, parseHm } from '../_shared/gen/core/date.ts';
import { isValidTz } from '../_shared/gen/core/tz.ts';
import { t } from '../_shared/gen/i18n/i18n.ts';
import { notifyText } from '../_shared/gen/logic/notify-text.ts';
import { dndDeferUntil, remindAtOf, type EventRemindRow, type TodoRemindRow } from '../_shared/gen/logic/remind.ts';
import { resolveOverride } from '../_shared/push/stub.ts';
import { loadVapid, VapidSigner, type VapidKeys, type VapidLoad } from '../_shared/push/vapid.ts';
import { handle } from './core.ts';
import type { RoundLogic } from './round.ts';
import { makeStore } from './store.ts';

/** 共享 logic 接到 round.ts 的结构类型上（行是数据库原样读出的，类型在 shared 一侧） */
export const LOGIC: RoundLogic = {
  remindAtOf: (kind, row, tz, now, prev) =>
    kind === 'todo' ? remindAtOf('todo', row as unknown as TodoRemindRow, tz, now, prev) : remindAtOf('event', row as unknown as EventRemindRow, tz, now, prev),
  isValidTz,
  dndDeferUntil,
  eventStartAt: (row) => (typeof row.time === 'string' && typeof row.tz === 'string' && typeof row.date === 'string' ? msAt(row.date, parseHm(row.time), row.tz) : null),
  notify: (i) => notifyText(i),
  t: (key, params, locale) => t(key as never, params as never, locale === 'ko-KR' ? 'ko-KR' : 'zh-CN'),
  // B5 填实现（logic/anniv 的 nextDate + 提醒偏移）；现在回 null：第 0 步不改纪念日、第 6 步推过以后不写下一次
  annivNext: () => null,
};

// 每个实例只自检一次（C-9）；三个变量的值变了（换钥匙后重新部署会起新实例，这里只是兜底）就重做
// 三个值整串比较（代码审查 S10；值只在内存里，不写日志）。VapidSigner 跟着这份缓存走（下面的 signerFor）：缓存换了才新建 signer，
// 同一实例跨轮复用，“同一 origin 签一次”才成立
let vapidMemo: { priv: string | undefined; pub: string | undefined; sub: string | undefined; p: Promise<VapidLoad> } | null = null;
function vapidOnce(priv: string | undefined, pub: string | undefined, sub: string | undefined): Promise<VapidLoad> {
  if (!vapidMemo || vapidMemo.priv !== priv || vapidMemo.pub !== pub || vapidMemo.sub !== sub) vapidMemo = { priv, pub, sub, p: loadVapid(priv, pub, sub) };
  return vapidMemo.p;
}
// 签名器跟着钥匙对象走：vapidOnce 的缓存没换，钥匙对象就是同一个，签名器（按 origin 缓存的 JWT）跨轮复用；换了钥匙就新建（S10）
let signerMemo: { keys: VapidKeys; signer: VapidSigner } | null = null;
function signerFor(keys: VapidKeys): VapidSigner {
  if (!signerMemo || signerMemo.keys !== keys) signerMemo = { keys, signer: new VapidSigner(keys, Date.now) };
  return signerMemo.signer;
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
    logic: LOGIC,
    signerFor,
  });
});
