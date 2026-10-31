// usage-report 入口（架构第 6 节函数表、6.1）：给独立 Worker lemo-ops 调，鉴权是 x-ops-secret。
// 经 supabase-js（service role）读 private.heartbeat、private.pending_deletions 和 rpc long_transactions、auth_mail_counts
// （0.29 续第 52 条：经 schema('private')）；不直连数据库（不 import _shared/db.ts），不碰 R2。逻辑和测试见 core.ts、tests/functions/usage-report.test.ts。
// 发信量（0.38 第 12 条，core.ts 的 authMail）：auth_1h 取 rpc private.auth_mail_counts()（迁移 20261029230000，数 auth.audit_log_entries
// 里的 user_recovery_requested）；resend_24h 要有读权限的 Resend 密钥，暂不接（不传，返回体里为 null）。
// 没有 profile 的 auth 用户（ORPHAN-alert，core.ts 的 orphanUsers）：rpc private.orphan_auth_users()（迁移 20261031160000）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authMailFromRpc, handle, orphansFromRpc, type UsageDb } from './core.ts';

function makeDb(): UsageDb {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('misconfigured');
  const priv = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).schema('private');
  return {
    async heartbeats(signal) {
      const { data, error } = await priv.from('heartbeat').select('name, at, detail').abortSignal(signal);
      if (error) throw new Error('db');
      return data ?? [];
    },
    async pendingDeletions(signal) {
      const { data, error } = await priv.from('pending_deletions').select('purge_after, purge_started_at').abortSignal(signal);
      if (error) throw new Error('db');
      return data ?? [];
    },
    async longTxCount(signal) {
      const { data, error } = await priv.rpc('long_transactions').abortSignal(signal);
      if (error) throw new Error('db');
      return Array.isArray(data) ? data.length : 0;
    },
    async authMail(signal) {
      const { data, error } = await priv.rpc('auth_mail_counts').abortSignal(signal);
      if (error) throw new Error('db');
      return authMailFromRpc(data);
    },
    async orphanUsers(signal) {
      const { data, error } = await priv.rpc('orphan_auth_users').abortSignal(signal);
      if (error) throw new Error('db');
      return orphansFromRpc(data);
    },
  };
}

Deno.serve((req) => {
  let db: UsageDb | null = null;
  try {
    db = makeDb();
  } catch {
    db = null; // 没配好：鉴权之后由 core.ts 回 misconfigured（没带对密钥的调用方看不出来）
  }
  return handle(req, { opsSecret: Deno.env.get('OPS_SECRET'), db, now: Date.now, log: (code) => console.error(`usage-report: ${code}`) });
});
