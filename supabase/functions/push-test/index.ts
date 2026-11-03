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
import { loadVapid, VapidSigner, type VapidKeys, type VapidLoad } from '../_shared/push/vapid.ts';
import { versionGate } from '../_shared/version-gate.ts';
import { handle, type TestDevice } from './core.ts';

const log = (code: string) => console.error(`push-test: ${code}`);
const NO_STORE = { 'cache-control': 'no-store' };

let vapidMemo: { priv?: string | undefined; pub?: string | undefined; sub?: string | undefined; p: Promise<VapidLoad> } | null = null;
function vapidOnce(priv: string | undefined, pub: string | undefined, sub: string | undefined): Promise<VapidLoad> {
  if (!vapidMemo || vapidMemo.priv !== priv || vapidMemo.pub !== pub || vapidMemo.sub !== sub) vapidMemo = { priv, pub, sub, p: loadVapid(priv, pub, sub) };
  return vapidMemo.p;
}
// 签名器跟着钥匙对象走（按 origin 缓存 JWT，D1-6）；换了钥匙就新建
let signerMemo: { keys: VapidKeys; signer: VapidSigner } | null = null;
function signerFor(keys: VapidKeys): VapidSigner {
  if (!signerMemo || signerMemo.keys !== keys) signerMemo = { keys, signer: new VapidSigner(keys, Date.now) };
  return signerMemo.signer;
}

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return new Response(JSON.stringify({ error: 'misconfigured' }), { status: 500, headers: { 'content-type': 'application/json', ...NO_STORE } });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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
        if (e instanceof AuthError) return { ok: false, response: e.toResponse(NO_STORE), code: e.code };
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
    vapid: () => vapidOnce(Deno.env.get('VAPID_PRIVATE_KEY'), Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_SUBJECT')),
    buildPayload,
    deliver: (dev, payload, opt, keys, override) => deliver(dev, payload, opt, { fetch: (u, init) => fetch(u, init), signer: signerFor(keys), override }),
    now: Date.now,
    log,
  });
});
