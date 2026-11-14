// vault 入口（架构 5.5、第 6 节 vault 行；B5 任务单 S2～S5、S8）：组装依赖、入口处查版本门（vault 不在免查名单），逻辑在 core.ts。
// 用到的库对象：
//   • fn_vault 直连（_shared/db.ts 的 withVaultUser，store.ts）：private.vault、vault_credentials、device_secrets、webauthn_challenges、vault_ai、
//     note_vectors（只删）、public.notes、note_images、note_files（只读）、private.purge_vault_impl；
//   • service role（supabase-js）：private.account_usable、session_alive（经 _shared/auth.ts）、private.take_rate、devices（推送端点）、profiles（邮件语言、时区）、
//     logs（写 vault_reset）、app_config（版本门）、Auth 管理接口 getUserById（重设邮件收件人）。
// R2：vault-images、images 两个桶（移进移出、save 核对图片），令牌 R2_FN_*（8.6）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；FN_VAULT_DB_URL；VAULT_KEY、VAULT_PIN_PEPPER、VAULT_TOKEN_SECRET（各 32 字节 base64，R-220）；
//   R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX；RESEND_API_KEY；VAPID_*、PUSH_SERVICE_OVERRIDE_URL、LEMO_LOCAL_PUSH_STUB（同 push-test）。
// 不加 CORS（0.48 第 4 条）：浏览器经 /sb 同源调用。日志只经 _shared/fn-log.ts 记错误码。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { background } from '../_shared/background.ts';
import { withVaultUser } from '../_shared/db.ts';
import { envKind } from '../_shared/env-kind.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { json } from '../_shared/http.ts';
import { mailLocale, skipTestRecipients, vaultResetMail } from '../_shared/account-mail.ts';
import { sendMail } from '../_shared/mail-send.ts';
import { timedFetch } from '../_shared/net.ts';
import { r2FromEnv } from '../_shared/objstore-env.ts';
import { buildPayload } from '../_shared/push/payload.ts';
import { cachedVapid, pushToDevices } from '../_shared/push/notify.ts';
import { resolveOverride } from '../_shared/push/stub.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { decodeKey32 } from '../_shared/vault-crypto.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { tzLabel } from '../_shared/gen/i18n/tz-label.ts';
import { noteFilePath, noteFileThumbPath } from '../_shared/gen/logic/files/media-path.ts';
import { DOC_TYPES, type DocKind } from '../_shared/gen/manifests/attachments.ts';
import {
  lockSeconds, PIN_RE, VAULT_FAILS_PER_LEVEL, VAULT_RESET_OTP_MAX_AGE_S, vaultImageKey, vaultRequest,
  WEBAUTHN_CHALLENGE_TTL_S, WEBAUTHN_RP_ID,
} from '../_shared/gen/schema/vault.ts';
import type { VaultReq, VaultRules } from './common.ts';
import { handle } from './core.ts';
import { vaultStore } from './store.ts';

const log = codeLogger('vault');
/** 安全通知：1 小时内送达有意义，高优先级（锁定、改密码要马上知道） */
const VAULT_PUSH_OPTIONS = { ttl: 3600, urgency: 'high' } as const;

/** kind → MIME（Map 取值，不用方括号取属性：check_backend F7） */
// 先落到显式类型再 Object.entries：发布脚本第 1 步就跑 check_backend，那时 _shared/gen 还没生成，导入的类型看不出来会报 F7（11-14 publish-run 测试红）
const DOC_TYPE_MAP: Readonly<Record<string, string>> = DOC_TYPES;
const DOC_MIME = new Map<string, string>(Object.entries(DOC_TYPE_MAP));

const RULES: VaultRules = {
  pinRe: PIN_RE, failsPerLevel: VAULT_FAILS_PER_LEVEL, lockSeconds, resetOtpMaxAgeS: VAULT_RESET_OTP_MAX_AGE_S,
  challengeTtlS: WEBAUTHN_CHALLENGE_TTL_S, rpId: WEBAUTHN_RP_ID, imageKey: vaultImageKey,
  // B4b-1 移进移出带附件；kind 已经过库里的 check，这里只换类型
  fileKey: (uid, noteId, id, kind) => noteFilePath(uid, noteId, id, kind as DocKind),
  fileThumbKey: noteFileThumbPath,
  docMime: (kind) => DOC_MIME.get(kind) ?? 'application/octet-stream',
};

const KEYS = {
  master: decodeKey32(Deno.env.get('VAULT_KEY')),
  pepper: decodeKey32(Deno.env.get('VAULT_PIN_PEPPER')),
  tokenSecret: decodeKey32(Deno.env.get('VAULT_TOKEN_SECRET')),
};
const R2 = r2FromEnv();

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const blocked = await versionGate('vault', req, appConfigMinLoader(admin));
  if (blocked) return blocked;
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const send = skipTestRecipients((to, mail) => (resendKey ? sendMail(resendKey, to, mail) : Promise.resolve(false)), log);
  const override = resolveOverride(Deno.env.get('PUSH_SERVICE_OVERRIDE_URL'), url, Deno.env.get('LEMO_LOCAL_PUSH_STUB'));

  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    parse(v) {
      const p = vaultRequest.safeParse(v);
      return p.success ? (p.data as VaultReq) : null;
    },
    rules: RULES,
    takeRate: rpcTakeRate(admin),
    tx: (uid, fn) => withVaultUser(uid, (sql) => fn(vaultStore(sql, uid))),
    keys: KEYS,
    r2: R2,
    env: envKind(url),
    async notify(userId, event) {
      if (!override.ok) throw new Error('override');
      const v = await cachedVapid(Deno.env.get('VAPID_PRIVATE_KEY'), Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_SUBJECT'));
      if (!v.ok) throw new Error(v.reason);
      const { data, error } = await admin.from('devices').select('push_endpoint, p256dh, auth').eq('user_id', userId)
        .is('deleted_at', null).not('push_endpoint', 'is', null).order('id', { ascending: true });
      if (error) throw new Error('db');
      const payload = buildPayload({ type: 'vault', user_id: userId, event });
      await pushToDevices(data ?? [], payload, VAULT_PUSH_OPTIONS, v.keys, override.url, (u, init) => fetch(u, init), Date.now);
    },
    async resetMail(userId, atMs) {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      const to = data?.user?.email;
      if (error || !to) throw new Error('auth');
      const p = await admin.from('profiles').select('ui_locale, current_tz').eq('user_id', userId).maybeSingle();
      if (p.error) throw new Error('db');
      const loc = mailLocale(p.data?.ui_locale);
      if (!(await send(to, vaultResetMail(loc, atMs, p.data?.current_tz, tzLabel)))) throw new Error('mail');
    },
    async insertLog(userId, row) {
      const { error } = await admin.from('logs').insert({ user_id: userId, t: row.t, kind: 'run', act: row.act, src: 'vault', code: row.code ?? null });
      if (error) throw new Error('db');
    },
    background,
    now: Date.now,
    log,
  });
});
