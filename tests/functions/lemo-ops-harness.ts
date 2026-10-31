// lemo-ops 测试共用的假环境（tests/functions/lemo-ops*.test.ts）：时钟、数据库、Resend 收件箱、KV，以及 usage-report 的故障开关。
// 假 fetch 把 /functions/v1/usage-report 接到真的 usage-report/core.ts（数据库用假对象），Resend 收件箱用数组代替，KV 用内存 Map。
import { handle, type UsageDb } from '../../supabase/functions/usage-report/core.ts';
import { runDaily, runHeartbeat, runScheduled, type Env } from '../../workers/lemo-ops/src/index.ts';
import { SITE_ORIGIN, VERSION_JSON_PATH } from '../../workers/lemo-ops/src/version.ts';

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
  /** 线上 version.json（R-270）：字符串 = 返回 {version: 它}；其他是故障模式；body:… 原样返回这段文字 */
  let site: string | { fail: 'http503' | 'hang' | 'network' } | { body: string } = '4.0.0';
  let siteInit: RequestInit | undefined;
  /** 最近一次 version.json 请求“已经读完”：响应体读完（或请求抛错）后，再让出一次事件循环才 resolve，
   *  这时 lemo-ops 的 fetchText 已经走完 finally、清掉了它的 10 秒计时器（hang 模式永不 resolve）。
   *  setImmediate 不交给假时钟（测试只假 setTimeout / clearTimeout），所以和假时钟无关 */
  let siteDone: Promise<void> = Promise.resolve();

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
    if (url.startsWith(`${SITE_ORIGIN}${VERSION_JSON_PATH}?t=`)) {
      siteInit = init;
      let finish = () => {};
      siteDone = new Promise<void>((r) => (finish = () => void setImmediate(r)));
      /** 响应体读完才算完 */
      const reply = (body: string, status: number) => {
        const res = new Response(body, { status });
        const read = res.text.bind(res);
        res.text = async () => {
          try {
            return await read();
          } finally {
            finish();
          }
        };
        return res;
      };
      if (typeof site === 'string') return reply(JSON.stringify({ version: site }), 200);
      if ('body' in site) return reply(site.body, 200);
      if (site.fail === 'network') {
        finish();
        throw new TypeError('fetch failed');
      }
      if (site.fail === 'http503') return reply('busy', 503);
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
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
    CF_VERSION_METADATA: { id: 'ver-id', tag: 'v4.0.0', timestamp: '2026-10-28T23:00:00Z' },
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
    /** 发信量（0.38 第 12 条）：undefined = 不提供读取器（默认；index.ts 已经接上 rpc auth_mail_counts，这里默认不接，测“没接”那几步）；'error' = 读出错；对象原样返回（可以故意给坏形状） */
    setAuthMail(v: { auth_1h: number; resend_24h?: number | null } | Record<string, unknown> | 'error' | undefined) {
      if (v === undefined) delete db.authMail;
      else
        db.authMail = async () => {
          if (v === 'error') throw new Error('audit log down');
          return v as { auth_1h: number };   // 坏形状也原样给出去，测 usage-report 的降级
        };
    },
    /** 没有 profile 的 auth 用户（ORPHAN-alert）：undefined = 不提供读取器（默认，测“没接”）；'error' = 读出错；对象原样返回（可以故意给坏形状） */
    setOrphans(v: { count: number; latest_at: string | null } | Record<string, unknown> | 'error' | undefined) {
      if (v === undefined) delete db.orphanUsers;
      else
        db.orphanUsers = async () => {
          if (v === 'error') throw new Error('auth.users down');
          return v as { count: number; latest_at: string | null };
        };
    },
    logs,
    setSite(v: typeof site) {
      site = v;
    },
    get siteInit() {
      return siteInit;
    },
    get siteDone() {
      return siteDone;
    },
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

