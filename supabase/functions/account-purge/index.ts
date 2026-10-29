// account-purge 入口（架构第 6 节“account-purge 怎么执行”，0.38 第 24 条 S9）：cron 函数，鉴权是 x-cron-secret。
// 逻辑和测试见 core.ts、tests/functions/account-purge.test.ts。
// 数据库只经 supabase-js（service role）：private.pending_deletions、admins、pending_signups、counters、deleted_accounts、heartbeat
//   和 public.profiles（0.29 续第 52 条：经 schema('private')，只用 0001 第 18 节已有的授权）；**不用 fn_vault、不直连数据库**
//   （不 import _shared/db.ts、不读 FN_VAULT_DB_URL），行全部靠 auth.admin.deleteUser 的外键级联删。
// R2 经 _shared/gen/objstore.ts（第 6 节 R2 九个函数之一）；backups 桶经 supabase-js 的 Storage。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台自带）；CRON_SECRET、RESEND_API_KEY、SIGNUP_HASH_SECRET（8.4：account 包括 account-purge）；
//   R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX（8.4）。
// 部署时函数没有 import map，写全 npm: 版本（和 package.json、supabase/functions/deno.json 一致）
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createObjStore } from '../_shared/gen/objstore.ts';
import type { Mail } from '../_shared/account-mail.ts';
import { BACKUP_BUCKET, BackupsSubdirError, HEARTBEAT, handle, type Backups, type PurgeStore, type R2 } from './core.ts';

const RESEND_URL = 'https://api.resend.com/emails';
const MAIL_FROM = '柠檬记 <noreply@lemomemo.com>';   // 和 invite-signup、account 同一个发件人
const NET_TIMEOUT_MS = 8000;
const LIST_LIMIT = 1000;

// 没有生成的库类型：按 _shared/auth.ts 的写法用不带泛型的 SupabaseClient（行一律当 any，返回值逐个收窄）
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw new Error('db');
  return r.data;
}

/** PostgREST 的 or 过滤里时间值加双引号（里面有冒号和点） */
const unclaimedOr = (staleIso: string) => `purge_started_at.is.null,purge_started_at.lt."${staleIso}"`;

function makeStore(admin: Admin): PurgeStore {
  const priv = admin.schema('private');
  const pd = () => priv.from('pending_deletions');
  return {
    async listRemind(nowIso, untilIso) {
      return must(await pd().select('user_id, purge_after').eq('notice_sent', false).gt('purge_after', nowIso).lte('purge_after', untilIso)) ?? [];
    },
    async casNotice(userId, from, to) {
      const rows = must(await pd().update({ notice_sent: to }).eq('user_id', userId).eq('notice_sent', from).select('user_id'));
      return Array.isArray(rows) && rows.length === 1;
    },
    async listDue(nowIso, staleIso) {
      return must(await pd().select('user_id, purge_after').lte('purge_after', nowIso).or(unclaimedOr(staleIso)).order('purge_after')) ?? [];
    },
    async claim(userId, nowIso, staleIso) {
      const rows = must(await pd().update({ purge_started_at: nowIso }).eq('user_id', userId).lte('purge_after', nowIso).or(unclaimedOr(staleIso)).select('user_id'));
      return Array.isArray(rows) && rows.length === 1;
    },
    async release(userId, claimedIso) {
      must(await pd().update({ purge_started_at: null }).eq('user_id', userId).eq('purge_started_at', claimedIso));
    },
    async stillClaimed(userId, claimedIso) {
      return must(await pd().select('user_id').eq('user_id', userId).eq('purge_started_at', claimedIso).maybeSingle()) !== null;
    },
    async isAdmin(userId) {
      return must(await priv.from('admins').select('user_id').eq('user_id', userId).maybeSingle()) !== null;
    },
    async profile(userId) {
      return must(await admin.from('profiles').select('disabled_at, disabled_reason, ui_locale, current_tz').eq('user_id', userId).maybeSingle());
    },
    async deletePendingSignup(h) {
      must(await priv.from('pending_signups').delete().eq('email_hash', h));
    },
    async deleteCounterKey(key) {
      must(await priv.from('counters').delete().eq('key', key));
    },
    async deleteUserCounters(userId) {
      // 键是三段 <用途>:<第二段>:<第三段>，第一段、第三段都不准有冒号（counters 的 check 约束），
      // 所以 like '%:<uuid>:%' 和 split_part(key, ':', 2) = <uuid> 等价；uuid 里没有 % 和 _
      must(await priv.from('counters').delete().like('key', `%:${userId}:%`));
    },
    async insertDeletedAccount(userId) {
      must(await priv.from('deleted_accounts').upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true }));
    },
    async remainingRows(userId) {
      const a = await admin.from('profiles').select('user_id', { count: 'exact', head: true }).eq('user_id', userId);
      const b = await pd().select('user_id', { count: 'exact', head: true }).eq('user_id', userId);
      if (a.error || b.error || a.count === null || b.count === null) throw new Error('db');
      return a.count + b.count;
    },
    async writeHeartbeat(detail) {
      must(await priv.from('heartbeat').upsert({ name: HEARTBEAT, at: new Date().toISOString(), detail }, { onConflict: 'name' }));
    },
  };
}

function makeBackups(admin: Admin): Backups {
  const bucket = () => admin.storage.from(BACKUP_BUCKET);
  async function listNames(path: string): Promise<{ name: string; folder: boolean }[]> {
    const out: { name: string; folder: boolean }[] = [];
    for (let offset = 0; ; offset += LIST_LIMIT) {
      const { data, error } = await bucket().list(path, { limit: LIST_LIMIT, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error('storage');
      for (const o of data ?? []) out.push({ name: o.name, folder: o.id === null });
      if ((data ?? []).length < LIST_LIMIT) return out;
    }
  }
  return {
    async listDates() {
      return (await listNames('')).filter((o) => o.folder).map((o) => o.name);
    },
    async listUserFiles(date, userId) {
      const items = await listNames(`${date}/${userId}`);
      if (items.some((o) => o.folder)) throw new BackupsSubdirError();   // 这一层只该有文件；list 不递归，子目录删不到（K3 安全审查低 9）
      return items.map((o) => `${date}/${userId}/${o.name}`);
    },
    async remove(paths) {
      for (let i = 0; i < paths.length; i += LIST_LIMIT) {
        const { error } = await bucket().remove(paths.slice(i, i + LIST_LIMIT));
        if (error) throw new Error('storage');
      }
    },
  };
}

function makeR2(): R2 | null {
  const endpoint = Deno.env.get('R2_ENDPOINT');
  const accessKeyId = Deno.env.get('R2_FN_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_FN_SECRET_ACCESS_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return createObjStore({
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucketPrefix: Deno.env.get('R2_BUCKET_PREFIX') ?? '',
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
  });
}

async function sendMail(apiKey: string, to: string, mail: Mail): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
  try {
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: mail.subject, text: mail.text }),
      signal: ctl.signal,
      redirect: 'error',
    });
    await r.body?.cancel();
    return r.ok;
  } finally {
    clearTimeout(t);
  }
}

const log = (code: string) => console.error(`account-purge: ${code}`);

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  let r2: R2 | null = null;
  try {
    r2 = makeR2();
  } catch {
    r2 = null;   // 地址不是 https 等：鉴权之后由 core.ts 回 misconfigured
  }
  const ok = admin !== null && !!resendKey;
  return handle(req, {
    cronSecret: Deno.env.get('CRON_SECRET'),
    store: ok ? makeStore(admin) : null,
    r2: ok ? r2 : null,
    backups: ok ? makeBackups(admin) : null,
    async userEmail(userId) {
      if (!admin) throw new Error('misconfigured');
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw new Error('auth');
      }
      return data.user?.email ?? null;
    },
    async deleteUser(userId) {
      if (!admin) throw new Error('misconfigured');
      const { error } = await admin.auth.admin.deleteUser(userId);   // 硬删（不传 shouldSoftDelete）
      if (error) throw new Error('auth');
    },
    sendMail: (to, mail) => (resendKey ? sendMail(resendKey, to, mail) : Promise.resolve(false)),
    hashSecret: Deno.env.get('SIGNUP_HASH_SECRET'),
    now: Date.now,
    log,
  });
});
