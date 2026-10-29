// lemo-ops 测试共用的假环境（tests/functions/lemo-ops*.test.ts）：时钟、数据库、Resend 收件箱、KV，以及 usage-report 的故障开关。
// 假 fetch 把 /functions/v1/usage-report 接到真的 usage-report/core.ts（数据库用假对象），Resend 收件箱用数组代替，KV 用内存 Map。
import { handle, type UsageDb } from '../../supabase/functions/usage-report/core.ts';
import { runDaily, runHeartbeat, runScheduled, type Env } from '../../workers/lemo-ops/src/index.ts';

export const M = 60_000;
export const H = 60 * M;
export const T0 = Date.parse('2026-10-29T00:00:00Z');
export const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';   // ≥ 32 字节

interface SentMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  auth: string | null;
}

/** 一个假的“世界”：时钟、数据库、Resend 收件箱、KV，以及 usage-report 的故障开关 */
export function world() {
  let now = T0;
  const kv = new Map<string, string>();
  const inbox: SentMail[] = [];
  const hb = new Map<string, number>(); // name → 心跳时刻
  let pending: Array<{ purge_after: number; purge_started_at: number | null }> = [];
  let longTx = 0;
  let cleanupMs: number | undefined;
  let pushDetail: unknown = null;
  let mode: 'ok' | 'db_error' | 'db_slow' | 'bad_ts' | 'http500' | 'hang' | 'bad_body' | 'network' = 'ok';
  let resendDown = false;
  let keepaliveStatus = 200;
  let usageBody: unknown = { ok: true, items: [] };
  const calls: string[] = [];
  const logs: string[] = [];
  let kvBroken = false;

  const db: UsageDb = {
    async heartbeats() {
      if (mode === 'db_error') throw new Error('connection refused');
      if (mode === 'db_slow') return new Promise(() => {});
      if (mode === 'bad_ts') return [{ name: 'push-dispatch', at: 'not-a-date', detail: null }];
      return [...hb].map(([name, at]) => ({ name, at: new Date(at).toISOString(), detail: name === 'cleanup' && cleanupMs !== undefined ? { rows: 1000, ms: cleanupMs } : name === 'push-dispatch' ? pushDetail : null }));
    },
    async pendingDeletions() {
      return pending.map((p) => ({ purge_after: new Date(p.purge_after).toISOString(), purge_started_at: p.purge_started_at === null ? null : new Date(p.purge_started_at).toISOString() }));
    },
    async longTxCount() {
      return longTx;
    },
  };

  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    const headers = new Headers(init.headers);
    if (url === 'https://api.resend.com/emails') {
      if (resendDown) return new Response('{"message":"down"}', { status: 500 });
      const b = JSON.parse(String(init.body)) as Omit<SentMail, 'auth'>;
      inbox.push({ ...b, auth: headers.get('authorization') });
      return new Response('{"id":"x"}', { status: 200 });
    }
    if (url === 'https://ref.supabase.co/functions/v1/usage-report') {
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'http500') return new Response('Internal Server Error', { status: 500 });
      if (mode === 'bad_body') return new Response('<html>oops</html>', { status: 200 });
      if (mode === 'hang') {
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      const part = (JSON.parse(String(init.body)) as { part: string }).part;
      if (part === 'usage') return new Response(JSON.stringify(usageBody), { status: 200 });
      const req = new Request(url, { method: 'POST', headers, body: init.body ?? null });
      return handle(req, { opsSecret: SECRET, db, now: () => now });
    }
    if (url === 'https://ref.supabase.co/rest/v1/app_config?select=min_client_version') {
      return new Response(keepaliveStatus === 200 ? '[{"min_client_version":"4.0.0"}]' : 'err', { status: keepaliveStatus });
    }
    throw new Error(`没想到的请求：${url}`);
  };

  const env: Env = {
    OPS_STATE: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => {
        if (kvBroken) throw new Error('kv down');
        kv.set(k, v);
      },
    },
    SUPABASE_URL: 'https://ref.supabase.co/',
    SUPABASE_ANON_KEY: 'test-anon',
    OPS_SECRET: SECRET,
    RESEND_API_KEY_OPS: 'test-resend',
    ALERT_TO: 'owner@example.test',
    ALERT_FROM: '柠檬记监控 <ops@example.test>',
    REQUIRED_HEARTBEATS: '',
  };

  /** 所有已上线的心跳都设成“刚写过” */
  const freshAll = () => {
    for (const n of ['push-dispatch', 'ai-classify', 'backup-daily', 'vault-file-sweep', 'account-purge', 'cleanup']) hb.set(n, now - M);
  };

  return {
    env,
    kv,
    inbox,
    calls,
    fetchFn,
    freshAll,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    setHeartbeat(name: string, msAgo: number) {
      hb.set(name, now - msAgo);
    },
    dropHeartbeat(name: string) {
      hb.delete(name);
    },
    setPending(rows: Array<{ afterAgo: number; startedAgo: number | null }>) {
      pending = rows.map((r) => ({ purge_after: now - r.afterAgo, purge_started_at: r.startedAgo === null ? null : now - r.startedAgo }));
    },
    setLongTx(n: number) {
      longTx = n;
    },
    setCleanup(ms: number | undefined, ago = M) {
      cleanupMs = ms;
      hb.set('cleanup', now - ago);
    },
    setPushDetail(d: unknown) {
      pushDetail = d;
    },
    setMode(m: typeof mode) {
      mode = m;
    },
    setResendDown(v: boolean) {
      resendDown = v;
    },
    setKeepalive(status: number) {
      keepaliveStatus = status;
    },
    setUsage(body: unknown) {
      usageBody = body;
    },
    logs,
    setKvBroken(v: boolean) {
      kvBroken = v;
    },
    tick() {
      return runHeartbeat(env, fetchFn, now, (c) => logs.push(c));
    },
    daily() {
      return runDaily(env, fetchFn, now, (c) => logs.push(c));
    },
    scheduled(cron: string) {
      return runScheduled(cron, env, fetchFn, now, (c) => logs.push(c));
    },
  };
}

