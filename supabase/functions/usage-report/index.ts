// usage-report 入口（架构第 6 节函数表、6.1）：给独立 Worker lemo-ops 调，鉴权是 x-ops-secret。
// 经 supabase-js（service role）读 private.heartbeat、private.pending_deletions 和 rpc long_transactions（0.29 续第 52 条：经 schema('private')）；
// 不直连数据库（不 import _shared/db.ts），不碰 R2。逻辑和测试见 core.ts、tests/functions/usage-report.test.ts。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { handle, type UsageDb } from './core.ts';

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
