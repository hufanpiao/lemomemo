// push-test 入口（架构第 6 节 push-test 行；B2 任务单 BE-6）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；VAPID_PRIVATE_KEY、VAPID_PUBLIC_KEY、VAPID_SUBJECT（和 push-dispatch 同一套，8.4）；
//   PUSH_SERVICE_OVERRIDE_URL、LEMO_LOCAL_PUSH_STUB（只给本机推送替身，D1-8；线上设了替身就回 500 misconfigured）。
// 用到的库对象：private.account_usable、private.session_alive（经 _shared/auth.ts）、private.take_rate、devices（只读本人的）、app_config（版本门）。
// 不加 CORS（0.48 第 4 条）：浏览器经 /sb 同源调用。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AuthError, requireActiveUser } from '../_shared/auth.ts';
import { buildPayload } from '../_shared/push/payload.ts';
import { deliver } from '../_shared/push/send.ts';
import { resolveOverride } from '../_shared/push/stub.ts';
import { cachedSigner, cachedVapid } from '../_shared/push/notify.ts';
import { json } from '../_shared/http.ts';
import { versionGate } from '../_shared/version-gate.ts';
import { handle, type TestDevice } from './core.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';

const log = (code: string) => console.error(`push-test: ${code}`);

// VAPID 钥匙和签名器的进程缓存在 _shared/push/notify.ts（B5 起和 vault 的安全通知共用一份）

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const blocked = await versionGate('push-test', req, async (signal) => {
    const { data, error } = await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle();
    if (error) throw new Error('db');
    return data?.min_client_version ?? null;
  });
  if (blocked) return blocked;
  const priv = admin.schema('private');
  return handle(req, {
    async authenticate(r) {
      try {
        return { ok: true, user: await requireActiveUser(r, admin) };
      } catch (e) {
        if (e instanceof AuthError) return { ok: false, response: e.toResponse(), code: e.code };
        throw e;
      }
    },
    store: {
      async takeRate(k, limit, windowS) {
        const { data, error } = await priv.rpc('take_rate', { p_key: k, p_limit: limit, p_window_s: windowS });
        if (error) throw new Error('db');
        return data === true;
      },
      async devices(userId) {
        const { data, error } = await admin.from('devices').select('id, push_endpoint, p256dh, auth').eq('user_id', userId)
          .is('deleted_at', null).not('push_endpoint', 'is', null).order('id', { ascending: true });
        if (error) throw new Error('db');
        return (data ?? []) as TestDevice[];
      },
    },
    override: resolveOverride(Deno.env.get('PUSH_SERVICE_OVERRIDE_URL'), url, Deno.env.get('LEMO_LOCAL_PUSH_STUB')),
    vapid: () => cachedVapid(Deno.env.get('VAPID_PRIVATE_KEY'), Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_SUBJECT')),
    buildPayload,
    deliver: (dev, payload, opt, keys, override) => deliver(dev, payload, opt, { fetch: (u, init) => fetch(u, init), signer: cachedSigner(keys, Date.now), override }),
    now: Date.now,
    log,
  });
});
