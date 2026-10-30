// invite-signup 入口（架构 5.6、第 6 节函数表）：匿名调用，邀请码注册。逻辑和测试见 core.ts、tests/functions/invite-signup.test.ts。
// 经 supabase-js（service role）读写 private.invites、private.pending_signups、rpc take_rate（0.29 续第 52 条：经 schema('private')），
// public.profiles、app_config；不直连数据库（不 import _shared/db.ts，不在 6.2 的名单里），不碰 R2。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）；TURNSTILE_SECRET、RESEND_API_KEY、PROXY_SECRET（8.4）；
//   SIGNUP_HASH_SECRET（邮箱、IP、验证码哈希的 HMAC 密钥）。
//   TURNSTILE_SITEVERIFY_URL、RESEND_EMAILS_URL：只给本机和 e2e 换出站地址（INVITE-mailpit，10-30），线上不设；
//   不设就用官方地址，值不合规整个函数回 500 misconfigured（规则见 outbound.ts）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { envKind } from '../_shared/env-kind.ts';
import { cachedMinClientVersion } from '../_shared/version-gate.ts';
import { handle, type AuthAdmin, type Store, type TurnstileResult } from './core.ts';
import { withStoreTimeouts } from './store-timeout.ts';
import { RESEND_EMAILS_URL, TURNSTILE_SITEVERIFY_URL, resolveOutboundUrl } from './outbound.ts';

const MAIL_FROM = '柠檬记 <noreply@lemomemo.com>';   // 5.6：发件人 noreply@lemomemo.com
const NET_TIMEOUT_MS = 8000;

// 没有生成的库类型：按 _shared/auth.ts 的写法用不带泛型的 SupabaseClient（行一律当 any，返回值在下面逐个收窄）
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw new Error('db');
  return r.data;
}

// 每次 store 调用由 store-timeout.ts 新建一个 signal 交进来，各查询挂 .abortSignal(signal)，超时就中止（INVITE-store-timeout）
function makeStore(admin: Admin, signal: AbortSignal): Store {
  const priv = admin.schema('private');
  return {
    async takeRate(key, limit, windowS) {
      const data = must(await priv.rpc('take_rate', { p_key: key, p_limit: limit, p_window_s: windowS }).abortSignal(signal));
      if (typeof data !== 'boolean') throw new Error('db');
      return data;
    },
    async getInvite(codeHash) {
      return must(await priv.from('invites').select('max_uses, used_count, expires_at').eq('code_hash', codeHash).abortSignal(signal).maybeSingle());
    },
    async casInviteUsed(codeHash, from, to, notExpiredAt) {
      let q = priv.from('invites').update({ used_count: to }).eq('code_hash', codeHash).eq('used_count', from);
      if (notExpiredAt) q = q.gt('expires_at', notExpiredAt);
      const rows = must(await q.select('code_hash').abortSignal(signal));
      return Array.isArray(rows) && rows.length === 1;
    },
    async putPending(emailHash, row) {
      must(await priv.from('pending_signups').upsert({ email_hash: emailHash, ...row }, { onConflict: 'email_hash' }).abortSignal(signal));
    },
    async getPending(emailHash) {
      return must(await priv.from('pending_signups').select('otp_hash, tries, expires_at').eq('email_hash', emailHash).abortSignal(signal).maybeSingle());
    },
    async casPendingTries(emailHash, from, to, otpHash) {
      const rows = must(await priv.from('pending_signups').update({ tries: to })
        .eq('email_hash', emailHash).eq('tries', from).eq('otp_hash', otpHash).select('email_hash').abortSignal(signal));
      return Array.isArray(rows) && rows.length === 1;
    },
    async deletePending(emailHash, otpHash) {
      const q = priv.from('pending_signups').delete().eq('email_hash', emailHash).abortSignal(signal);
      must(await (otpHash === undefined ? q : q.eq('otp_hash', otpHash)));
    },
    async insertProfile(userId, locale) {
      must(await admin.from('profiles').insert({ user_id: userId, ui_locale: locale }).abortSignal(signal));
    },
    // 架构 0.38 第 52 条：经函数侧版本门的缓存读（超时 1.5 秒、成功缓存 60 秒、失败缓存 10 秒放行，只记 gate_config_*）
    minClientVersion() {
      return cachedMinClientVersion(async (signal) => {
        const row = must(await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle()) as { min_client_version: string | null } | null;
        return row?.min_client_version ?? null;
      });
    },
  };
}

function makeAuth(admin: Admin): AuthAdmin {
  return {
    async createUser(email, locale) {
      // 不传 password：账号不许有密码（0.36；auth.users 上的 users_guard_no_password 触发器兜底）
      const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { locale } });
      if (error || !data.user) {
        const e = error as { code?: unknown; status?: unknown; message?: unknown } | null;
        const exists = e?.code === 'email_exists' || e?.code === 'user_already_exists'
          || (e?.status === 422 && typeof e.message === 'string' && /already (been )?registered|already exists/i.test(e.message));
        return { ok: false, exists };
      }
      return { ok: true, userId: data.user.id };
    },
    async deleteUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error('auth');
    },
    async magiclinkTokenHash(email) {
      const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      const h = data?.properties?.hashed_token;
      return error || typeof h !== 'string' || !h ? null : h;
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

async function verifyTurnstile(siteverifyUrl: string, secret: string, token: string, remoteIp: string | null): Promise<TurnstileResult> {
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set('remoteip', remoteIp);
  const r = await postWithTimeout(siteverifyUrl, { method: 'POST', body: form });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error('turnstile_http');
  }
  const j = (await r.json()) as { success?: unknown; hostname?: unknown; action?: unknown };
  return {
    success: j.success === true,
    hostname: typeof j.hostname === 'string' ? j.hostname : null,
    action: typeof j.action === 'string' ? j.action : null,
  };
}
async function sendMail(emailsUrl: string, apiKey: string, to: string, mail: { subject: string; text: string }): Promise<boolean> {
  const r = await postWithTimeout(emailsUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: mail.subject, text: mail.text }),
  });
  await r.body?.cancel();
  return r.ok;
}

const log = (code: string) => console.error(`invite-signup: ${code}`);

// 出站地址换成了回环地址（outbound.ts 的 overridden）时记 outbound_url_overridden：每个函数实例只记一次，只记日志码、不记地址（INVITE-sugg，10-30）
let overriddenLogged = false;

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const turnstileSecret = Deno.env.get('TURNSTILE_SECRET');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!url || !key || !turnstileSecret || !resendKey) {
    log('misconfigured');
    return new Response(JSON.stringify({ error: 'misconfigured' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  const env = envKind(url);
  // 出站地址（outbound.ts）：没设用官方地址；不合规不悄悄回落，当没配好（configured: false → 500 misconfigured）
  const siteverify = resolveOutboundUrl(Deno.env.get('TURNSTILE_SITEVERIFY_URL'), TURNSTILE_SITEVERIFY_URL, env);
  const emails = resolveOutboundUrl(Deno.env.get('RESEND_EMAILS_URL'), RESEND_EMAILS_URL, env);
  if (!siteverify.ok || !emails.ok) log('outbound_url_invalid');
  if (!overriddenLogged && ((siteverify.ok && siteverify.overridden) || (emails.ok && emails.overridden))) {
    overriddenLogged = true;
    log('outbound_url_overridden');
  }
  const siteverifyUrl = siteverify.ok ? siteverify.url : TURNSTILE_SITEVERIFY_URL;
  const emailsUrl = emails.ok ? emails.url : RESEND_EMAILS_URL;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return handle(req, {
    store: withStoreTimeouts((signal) => makeStore(admin, signal), { log }),
    auth: makeAuth(admin),
    env,
    verifyTurnstile: (token, ip) => verifyTurnstile(siteverifyUrl, turnstileSecret, token, ip),
    sendMail: (to, mail) => sendMail(emailsUrl, resendKey, to, mail),
    hashSecret: Deno.env.get('SIGNUP_HASH_SECRET'),
    proxySecret: Deno.env.get('PROXY_SECRET'),
    configured: siteverify.ok && emails.ok,
    now: Date.now,
    log,
  });
});
