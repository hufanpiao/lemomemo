// usage-report 入口（架构第 6 节函数表、6.1）：给独立 Worker lemo-ops 调，鉴权是 x-ops-secret；逻辑和测试见 core.ts、usage.ts、tests/functions/usage-report*.test.ts。
// 经 supabase-js（service role，schema('private')）读 heartbeat、pending_deletions 和 rpc long_transactions、auth_mail_counts、orphan_auth_users、security_events、
// usage_stats（{part: "usage"}，迁移 20261126100000）；不直连数据库（不 import _shared/db.ts）。resend_24h 要有读权限的 Resend 密钥，暂不接（不传，返回体里为 null）。
// R2 本月操作次数和存储量走 Cloudflare GraphQL（r2-ops.ts，出站经 _shared/net.ts 的 postOut），要 CF_ACCOUNT_ID、CF_ANALYTICS_TOKEN 两项
// （只读的账号分析令牌）；没配时不出操作次数两项，存储量退回 list 本环境四个桶数字节（第 6 节 R2 九个函数之一，_shared/objstore-env.ts，
// R2_FN_* 同一把；只列不读、不写、不删对象）。
import { serviceAdminOrNull } from '../_shared/admin.ts';
import { authMailFromRpc, handle, orphansFromRpc, securityFromRpc, type UsageDb } from './core.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { postOut } from '../_shared/net.ts';
import { r2BucketPrefix, r2FromEnv } from '../_shared/objstore-env.ts';
import { R2_BUCKETS } from '../_shared/objstore-buckets.ts';
import { readR2Ops, readR2Storage } from './r2-ops.ts';
import type { UsageSources } from './usage.ts';

function makeDb(): UsageDb {
  const admin = serviceAdminOrNull();
  if (!admin) throw new Error('misconfigured');
  const priv = admin.schema('private');
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

/** {part: "usage"} 的读取；数据库没配好时不提供（core.ts 先回 misconfigured） */
function makeUsage(): UsageSources | undefined {
  const admin = serviceAdminOrNull();
  if (!admin) return undefined;
  const priv = admin.schema('private');
  const r2 = r2FromEnv();
  const cfAccount = Deno.env.get('CF_ACCOUNT_ID');
  const cfToken = Deno.env.get('CF_ANALYTICS_TOKEN');
  const src: UsageSources = {
    async stats(days, exportCap, signal) {
      const { data, error } = await priv.rpc('usage_stats', { p_days: [...days], p_export_cap: exportCap }).abortSignal(signal);
      if (error) throw new Error('db');
      return Array.isArray(data) ? data[0] : data;
    },
    async backupMissing(date, signal) {
      const { data, error } = await priv.rpc('backup_missing', { p_date: date }).abortSignal(signal);
      if (error) throw new Error('db');
      return data;
    },
  };
  if (cfAccount && cfToken) {
    // 配了分析令牌：存储量读 Cloudflare 的快照（一次请求，B7a 评审第 14 条）
    const names = R2_BUCKETS.map((b) => `${r2BucketPrefix()}${b}`);
    src.r2Bytes = (signal) => readR2Storage((u, i) => postOut(fetch, u, i), cfAccount, cfToken, names, Date.now(), signal);
  } else if (r2) {
    // 没配分析令牌时退回逐页列桶（限制：每 1000 个对象一次 B 类操作，桶很大时可能超过 7 秒读取上限，这项就进 unreadable）
    src.r2Bytes = async (signal) => {
      let total = 0;
      for (const b of R2_BUCKETS) {
        let token: string | undefined;
        do {
          if (signal.aborted) throw new Error('aborted'); // 超时以后不再翻下一页
          const page = await r2.list(b, '', token ? { continuationToken: token } : {});
          for (const o of page.objects) total += o.size;
          token = page.nextToken ?? undefined;
        } while (token);
      }
      return total;
    };
  }
  if (cfAccount && cfToken) {
    src.r2Ops = (signal) => readR2Ops((u, i) => postOut(fetch, u, i), cfAccount, cfToken, Date.now(), signal);
  }
  return src;
}

Deno.serve((req) => {
  let db: UsageDb | null = null;
  try {
    db = makeDb();
  } catch {
    db = null; // 没配好：鉴权之后由 core.ts 回 misconfigured（没带对密钥的调用方看不出来）
  }
  return handle(req, { opsSecret: Deno.env.get('OPS_SECRET'), db, usage: db ? makeUsage() : undefined, now: Date.now, log: codeLogger('usage-report') });
});
