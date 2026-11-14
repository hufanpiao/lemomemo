// push-dispatch 入口（架构 5.3、第 6 节）：cron 函数，鉴权 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）；pg_cron 每分钟经 pg_net 调一次（迁移 20261103120000）。
// 处理逻辑在 core.ts；数据库只经 supabase-js（service role，store.ts），每个请求套 timedFetch 超时；不用 fn_vault、不直连数据库。
// 共享 logic 从 _shared/gen（build/copy_shared.mjs 生成）经 logic.ts 的 makeLogic 接进来。推送的加密、签名、发送在 _shared/push/。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；CRON_SECRET；VAPID_PRIVATE_KEY、VAPID_PUBLIC_KEY、VAPID_SUBJECT；PUSH_SERVICE_OVERRIDE_URL、LEMO_LOCAL_PUSH_STUB（只给本机替身）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { msAt, parseHm } from '../_shared/gen/core/date.ts';
import { isValidTz } from '../_shared/gen/core/tz.ts';
import { t } from '../_shared/gen/i18n/i18n.ts';
import { notifyText } from '../_shared/gen/logic/notify-text.ts';
import { allDayTimeOf, dndDeferUntil, REMIND_RULES_VER, remindAtOf, sameRemindDay } from '../_shared/gen/logic/remind.ts';
import { startAtOf } from '../_shared/gen/logic/remind-actions.ts';
import { occurrenceKey, reminderTag } from '../_shared/gen/logic/remind-route.ts';
import { annivNextOf } from '../_shared/gen/logic/anniv/next-date.ts';
import { resolveOverride } from '../_shared/push/stub.ts';
import { loadVapid, VapidSigner, type VapidKeys, type VapidLoad } from '../_shared/push/vapid.ts';
import { handle } from './core.ts';
import { makeLogic } from './logic.ts';
import type { RoundLogic } from './round.ts';
import { makeStore } from './store.ts';
import { codeLogger } from '../_shared/fn-log.ts';

/** 共享 logic 的接线（分支在 logic.ts 里只写一遍；这里只列 _shared/gen 下的函数，名字和测试替身一致，见 tests/edge/push-dispatch-logic-wiring.test.ts） */
export const LOGIC: RoundLogic = makeLogic({
  REMIND_RULES_VER, remindAtOf, allDayTimeOf, startAtOf, msAt, parseHm, sameRemindDay, isValidTz, dndDeferUntil, notifyText, t, reminderTag, occurrenceKey, annivNextOf,
});

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

const log = codeLogger('push-dispatch');

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } }) : null;
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
