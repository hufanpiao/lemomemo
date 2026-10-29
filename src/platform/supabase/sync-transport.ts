// 同步的网络一侧（K8；core/sync/types.ts 的 SyncTransport）：全部经 platform/supabase/client.ts 的 getSupabase（带 X-App-Version、426 通知），不自己 fetch（A12）
// • 放在 platform（架构 4.3b、0.38 第 58 条）：不 import core；类型只引 shared/schema/sync.ts，形状对上 SyncTransport，由 app 层交给 core
// • insert：upsert(onConflict: id, ignoreDuplicates)（4.2 幂等）：重发时这一行已在，返回空，再按 id 读回 rev
// • patch：rpc apply_patch(p_table, p_id, p_patch, p_base_rev, p_op_id, p_own_revs)（4.4；函数由后端在 B1 另建）
// • 拉取：select * 按 (synced_at, id) 升序键集翻页；墓碑按 (deleted_at, tbl, id)
// • Realtime：一个频道；同步表只订阅 INSERT、UPDATE（不订阅 DELETE：DELETE 事件不经过 RLS，4.3、TC-B1-29），tombstones 只订阅 INSERT
// • 每个请求 20 秒超时（同步是串行的，挂住的请求不能把后面的都卡住）；任何方法都不抛，失败变成 SendFailure
// • 错误只认码：plpgsql 的 raise exception '<码>' 在 message 里（session_revoked、not_found……），PostgREST 的在 code 里；
//   status 0 或 fetch 失败当断网；426 的响应体 {code: upgrade_required, min} 原样带出 min
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ConfigRows,
  NetResult,
  PatchArgs,
  PatchResponse,
  PullQuery,
  RealtimeHandlers,
  SendFailure,
  SessionCheck,
  TombstoneQuery,
  TzReportResult,
} from '../../../shared/schema/sync.ts';
import { patchResponse } from '../../../shared/schema/sync.ts';
import { readSessionId } from '../session.ts';
import { getSupabase } from './client.ts';

/** 这个实现提供的方法（和 core/sync/types.ts 的 SyncTransport 形状一致；TS 结构类型，app 层直接交给 createSync） */
export interface SupabaseSyncTransport {
  ensureSession(): Promise<SessionCheck>;
  refreshSession(): Promise<SessionCheck>;
  sessionId(): string | null;
  insertRow(table: string, data: Readonly<Record<string, unknown>>): Promise<NetResult<{ rev: number }>>;
  applyPatch(args: PatchArgs): Promise<NetResult<PatchResponse>>;
  pullRows(table: string, q: PullQuery): Promise<NetResult<unknown[]>>;
  fetchByIds(table: string, ids: readonly string[]): Promise<NetResult<unknown[]>>;
  pullTombstones(q: TombstoneQuery): Promise<NetResult<unknown[]>>;
  subscribe(tables: readonly string[], h: RealtimeHandlers): () => void;
  fetchConfig(): Promise<NetResult<ConfigRows>>;
  reportTz(tz: string, deviceId: string, platform: string): Promise<NetResult<TzReportResult>>;
}

export const REQUEST_TIMEOUT_MS = 20_000;
/** 令牌还剩这么多就先刷新再发（TC-B1-82 ①） */
export const REFRESH_MARGIN_MS = 60_000;
const ID_CHUNK = 100;

/** 刷新令牌回这些码（code 或 message 里包含）：会话已不在（被移除或被退出，0.29 续第 98、106 条；TC-B1-88 ④⑤） */
const REMOVED_AUTH_CODES = ['session_not_found', 'refresh_token_not_found'];
/** 403 且 code 或 message 里含这个也算被移除（TC-B1-88 ⑥） */
const REVOKED_403 = 'session_revoked';
const FETCH_FAILED = /failed to fetch|load failed|networkerror|network request failed|network error|fetcherror|aborterror|timeout/i;
const TOKEN = /^[a-z][a-z0-9_]*$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** supabase-js 的 { error, status } → SendFailure（单独导出测） */
export function toFailure(error: unknown, status: number | undefined): SendFailure {
  const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const msg = str(e['message']).trim();
  const pgCode = str(e['code']);
  const out: SendFailure = {};
  // 带 SQLSTATE 的（如 55P03“lock timeout”）、有 HTTP 状态的都是服务器回的，不是断网（K8 审查必改 7）
  if (status === undefined || status === 0) {
    out.network = true;
    return out;
  }
  out.status = status;
  const code = pgCode === 'upgrade_required' ? pgCode : TOKEN.test(msg) ? msg : pgCode;
  if (code) out.code = code;
  // detail 只放 sqlstate（apply_patch 的 patch_bad_args 把 “sqlstate sqlerrm” 放在 details 里）；服务器原文一律不带出来（0.38 第 62 条）
  const state = /^([0-9A-Z]{5})(\s|$)/.exec(str(e['details']));
  if (state?.[1]) out.detail = state[1];
  if (status === 426 || code === 'upgrade_required') {
    const min = e['min'];
    out.min = typeof min === 'string' && /^\d+\.\d+\.\d+$/.test(min) ? min : null;
  }
  return out;
}

/**
 * auth-js 刷新令牌的错误 → SessionCheck（单独导出测；TC-B1-88）：
 * ① 断网 ② 5xx ③ 429（以及 408）→ network（临时故障，不退出）；
 * ④ session_not_found ⑤ refresh_token_not_found（code 或 message 包含）⑥ 403 且含 session_revoked → removed；
 * ⑦⑧ 别的 4xx（含 refresh_token_already_used）→ failed：调用方记日志、再试一次，两次都 failed 才按被移除（send.ts refreshFlow）
 */
export function toSessionCheck(error: unknown): SessionCheck {
  if (!error) return 'ok';
  const e = typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const code = str(e['code']);
  const msg = str(e['message']);
  const name = str(e['name']);
  const status = typeof e['status'] === 'number' ? e['status'] : -1;
  const has = (needle: string): boolean => code.includes(needle) || msg.includes(needle);
  if (REMOVED_AUTH_CODES.some(has)) return 'removed';
  if (status === 403 && has(REVOKED_403)) return 'removed';
  if (status === 0 || name === 'AuthRetryableFetchError' || (status < 0 && FETCH_FAILED.test(msg))) return 'network';
  if (status >= 500 || status === 429 || status === 408) return 'network';
  if (status >= 400) return 'failed';
  return status < 0 ? 'network' : 'failed';   // 没有状态又不认识：按临时故障，不退出
}

/** PostgREST 的 or() 里的值加双引号（timestamptz 带 + 和 :） */
const q = (v: string): string => `"${v.replace(/["\\]/g, '')}"`;

/**
 * 请求的超时信号：有 AbortSignal.timeout 用它；没有（旧 Safari）用 AbortController + setTimeout（K8 审查必改 1）。
 * 请求结束时调 clear()，兜底的定时器随之清掉（K8 复审建议 2）
 */
export function timeoutSignal(ms: number = REQUEST_TIMEOUT_MS): { signal: AbortSignal | undefined; clear(): void } {
  const none = (): void => undefined;
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), clear: none };
  }
  if (typeof AbortController === 'undefined') return { signal: undefined, clear: none };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/** 整段最多等 ms，超时或抛错都给 fallback（串行链上不能有永不返回的等待，K8 审查必改 1） */
export function withTimeout<T>(p: PromiseLike<T> | (() => PromiseLike<T>), fallback: T, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    let q: PromiseLike<T>;
    try {
      q = typeof p === 'function' ? p() : p;
    } catch {
      clearTimeout(t);
      resolve(fallback);
      return;
    }
    q.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

interface PgRes<T> {
  data: T | null;
  error: unknown;
  status: number;
}

const NET: { ok: false; error: SendFailure } = { ok: false, error: { network: true } };

/** 这里的表名是运行时按清单来的，类型文件里的表名帮不上忙，按无类型的客户端用 */
type LooseDb = SupabaseClient;

type Call = <T>(fn: (db: LooseDb, signal: AbortSignal | undefined) => PromiseLike<PgRes<T>>) => Promise<NetResult<T>>;

/** 拉取：同步表按 (synced_at, id)、墓碑按 (deleted_at, tbl, id) 键集翻页；按 id 补拉 */
function pullMethods(call: Call): Pick<SupabaseSyncTransport, 'pullRows' | 'fetchByIds' | 'pullTombstones'> {
  return {
    pullRows(table, pq: PullQuery) {
      return call<unknown[]>((db, signal) => {
        let b = db.from(table).select('*').order('synced_at', { ascending: true }).order('id', { ascending: true }).limit(pq.limit);
        if (pq.since) b = b.gte('synced_at', pq.since);
        if (pq.after) {
          const s = q(pq.after.synced_at);
          b = b.or(`synced_at.gt.${s},and(synced_at.eq.${s},id.gt.${pq.after.id})`);
        }
        return signal ? b.abortSignal(signal) : b;
      });
    },

    async fetchByIds(table, ids) {
      const out: unknown[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const part = ids.slice(i, i + ID_CHUNK);
        const r = await call<unknown[]>((db, signal) => {
          const b = db.from(table).select('*').in('id', part);
          return signal ? b.abortSignal(signal) : b;
        });
        if (!r.ok) return r;
        out.push(...(r.value ?? []));
      }
      return { ok: true, value: out };
    },

    pullTombstones(tq: TombstoneQuery) {
      return call<unknown[]>((db, signal) => {
        let b = db
          .from('tombstones')
          .select('tbl,id,deleted_at')
          .order('deleted_at', { ascending: true })
          .order('tbl', { ascending: true })
          .order('id', { ascending: true })
          .limit(tq.limit);
        if (tq.since) b = b.gte('deleted_at', tq.since);
        if (tq.after) {
          const d = q(tq.after.deleted_at);
          const t = q(tq.after.tbl);
          b = b.or(`deleted_at.gt.${d},and(deleted_at.eq.${d},tbl.gt.${t}),and(deleted_at.eq.${d},tbl.eq.${t},id.gt.${tq.after.id})`);
        }
        return signal ? b.abortSignal(signal) : b;
      });
    },
  };
}

let channelSeq = 0;

/** Realtime：同步表只订阅 INSERT、UPDATE，tombstones 只订阅 INSERT（TC-B1-29） */
export function subscribeRealtime(client: () => Promise<LooseDb>, tables: readonly string[], h: RealtimeHandlers): () => void {
  let cancelled = false;
  let off: (() => void) | null = null;
  void client()
    .then(async (db) => {
      if (cancelled) return;
      try {
        await db.realtime.setAuth();
      } catch {
        // 拿不到令牌：照样订阅，连不上会走 onStatus('down') → 轮询
      }
      if (cancelled) return;
      const ch = db.channel(`lemo-sync-${++channelSeq}`);   // 每次唯一：上一个频道的 removeChannel 还没完成时，同名会拿到旧频道（K8 审查必改 5）
      for (const table of tables) {
        for (const event of ['INSERT', 'UPDATE'] as const) {
          ch.on('postgres_changes', { event, schema: 'public', table }, (p: { new: unknown }) => h.onRow(table, p.new));
        }
      }
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tombstones' }, (p: { new: unknown }) => h.onTombstone(p.new));
      ch.subscribe((status: string) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') h.onStatus('up');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') h.onStatus('down');
      });
      off = () => {
        void db.removeChannel(ch);
      };
    })
    .catch(() => {
      if (!cancelled) h.onStatus('down');
    });
  return () => {
    cancelled = true;
    off?.();
    off = null;
  };
}

export interface SupabaseTransportOptions {
  /** 测试用：换掉 getSupabase */
  client?: () => Promise<LooseDb>;
  /** 测试用：换掉“读本机会话的 session_id”（默认 platform/session.ts 的 readSessionId） */
  sessionId?: () => string | null;
  now?: () => number;
  /** 测试用：整段超时（默认 20 秒） */
  timeoutMs?: number;
}

export function createSupabaseTransport(opts: SupabaseTransportOptions = {}): SupabaseSyncTransport {
  const client = opts.client ?? (() => getSupabase() as unknown as Promise<LooseDb>);
  const now = opts.now ?? (() => Date.now());
  const ms = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** 一次请求：拿客户端 + 发请求整段包超时，超时按断网 */
  function call<T>(fn: (db: LooseDb, signal: AbortSignal | undefined) => PromiseLike<PgRes<T>>): Promise<NetResult<T>> {
    return withTimeout<NetResult<T>>(async () => {
      const db = await client();
      const ts = timeoutSignal(ms);
      try {
        const r = await fn(db, ts.signal);
        if (r.error) return { ok: false, error: toFailure(r.error, r.status) };
        return { ok: true, value: r.data as T };
      } finally {
        ts.clear();
      }
    }, NET, ms);
  }

  /** 刷新令牌：拿客户端 + refreshSession 整段包超时，超时按断网 */
  function refresh(): Promise<SessionCheck> {
    return withTimeout<SessionCheck>(async () => {
      const db = await client();
      const r = await db.auth.refreshSession();
      return toSessionCheck(r.error);
    }, 'network', ms);
  }

  return {
    async ensureSession() {
      // client()、getSession 整段包超时（getSession 内部可能等锁、等刷新），超时按断网
      const s = await withTimeout(async () => {
        const db = await client();
        const { data } = await db.auth.getSession();
        return data.session ?? null;
      }, undefined, ms);
      if (s === undefined) return 'network';
      if (!s) return 'failed';   // 本机没有会话：退出登录由 watchAccount 管，这里不当“被移除”
      const exp = typeof s.expires_at === 'number' ? s.expires_at * 1000 : null;
      if (exp !== null && exp - now() > REFRESH_MARGIN_MS) return 'ok';
      return refresh();
    },
    refreshSession: refresh,
    // 同步读 supabase-js 存在 localStorage 里的会话（和它下一次请求带的令牌是同一份；K6-sugg4 ①）
    sessionId: opts.sessionId ?? (() => readSessionId()),

    async insertRow(table, data) {
      const id = str(data['id']);
      const r = await call<{ rev: number }[]>((db, signal) => {
        const b = db.from(table).upsert({ ...data }, { onConflict: 'id', ignoreDuplicates: true }).select('rev');
        return signal ? b.abortSignal(signal) : b;
      });
      if (!r.ok) return r;
      const rev = r.value?.[0]?.rev;
      if (typeof rev === 'number') return { ok: true, value: { rev } };
      // 重发：这一行已经在服务器上了（ignoreDuplicates 不回行），按 id 读回 rev
      const again = await call<{ rev: number } | null>((db, signal) => {
        const b = db.from(table).select('rev').eq('id', id);
        return (signal ? b.abortSignal(signal) : b).maybeSingle();
      });
      if (!again.ok) return again;
      const rev2 = again.value?.rev;
      return typeof rev2 === 'number' ? { ok: true, value: { rev: rev2 } } : { ok: false, error: { status: 409, code: 'insert_conflict' } };
    },

    applyPatch(args: PatchArgs) {
      return call<PatchResponse>((db, signal) => {
        const b = db.rpc('apply_patch', { ...args, p_own_revs: [...args.p_own_revs] });
        return signal ? b.abortSignal(signal) : b;
      }).then((r) => {
        if (!r.ok) return r;
        const v = patchResponse.safeParse(r.value);   // 线上形状由 shared 的 zod 判（4.4.1）；不认识的当服务器出错
        if (!v.success) return { ok: false, error: { status: 502, code: 'bad_patch_response' } };
        return { ok: true, value: v.data };
      });
    },

    ...pullMethods(call),
    subscribe: (tables, h) => subscribeRealtime(client, tables, h),

    async fetchConfig() {
      const cfg = await call<ConfigRows['config']>((db, signal) => {
        const b = db.from('app_config').select('*').eq('id', 1);
        return (signal ? b.abortSignal(signal) : b).maybeSingle();
      });
      if (!cfg.ok) return cfg;
      const prof = await call<ConfigRows['profile']>((db, signal) => {
        const b = db.from('profiles').select('*');
        return (signal ? b.abortSignal(signal) : b).maybeSingle();
      });
      if (!prof.ok) return prof;
      return { ok: true, value: { config: cfg.value ?? null, profile: prof.value ?? null } };   // 转成本机缓存的形状由 core 做
    },

    reportTz(tz, deviceId, platform) {
      return call<TzReportResult>((db, signal) => {
        const b = db.rpc('report_tz', { tz, device_id: deviceId, platform });
        return signal ? b.abortSignal(signal) : b;
      });
    },
  };
}
