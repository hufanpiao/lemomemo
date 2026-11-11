// usage-report 入口（架构第 6 节函数表、6.1）：给独立 Worker lemo-ops 调，鉴权是 x-ops-secret；逻辑和测试见 core.ts、tests/functions/usage-report*.test.ts。
// 经 supabase-js（service role，schema('private')）读 heartbeat、pending_deletions 和 rpc long_transactions、auth_mail_counts、orphan_auth_users、security_events；
// 不直连数据库（不 import _shared/db.ts），不碰 R2。resend_24h 要有读权限的 Resend 密钥，暂不接（不传，返回体里为 null）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authMailFromRpc, handle, orphansFromRpc, securityFromRpc, type UsageDb } from './core.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';

function makeDb(): UsageDb {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('misconfigured');
  const priv = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } }).schema('private');
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
    async securityEvents(signal) {
      const { data, error } = await priv.rpc('security_events').abortSignal(signal);
      if (error) throw new Error('db');
      return securityFromRpc(data);
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
