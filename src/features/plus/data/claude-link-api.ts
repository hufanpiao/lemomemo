// 设置 › 在 Claude 聊天里记事（B3 任务单 FA-4、BE-5；架构 5.7；R-65；S-B3 中 6）
// • 现在连着没有、最后使用时间：经 RLS 直接读 api_tokens（tok_sel，只看得到本人的行），不经同步队列（清单里 sync: false）
//   有效 = 没吊销、建了不到 180 天（同 supabase/functions/_shared/intake-token.ts 的 TOKEN_TTL_MS）；最后使用 = 有效码里最晚的 last_used_at
// • 生成连接码：经 fn-post 的 sendFn POST token-admin {action: 'create'}，回 {token, id, expires_at}；明文码只在这一次响应里，界面只显示这一次、不做成链接、不存
//   409 too_many_tokens（同时最多 5 个）、429 rate_limited（每天 10 次）各自提示；426 由 appFetch 出升级横幅（token-admin 过版本门）
// • 断开连接：PATCH api_tokens set revoked_at（guard_token_revoke 改成 now()），只改 revoked_at 为空的行（revoked_at=is.null），
//   一行已吊销不会让整批报错；PATCH /rest/v1/api_tokens 免查版本（前端会审），不走同步队列
// • 各自 8 秒超时；只在设置这一块（plus 懒加载块）里，不进首屏
// 纯 TS：不准 import React（A1）
import { getSupabase } from '../../../platform/supabase/client.ts';
import { sendFn, type FnPostOptions } from './fn-post.ts';
import { onlineNow } from '../../../platform/online.ts';

export const LINK_TIMEOUT_MS = 8000;
/** 连接码多久过期（天），同 _shared/intake-token.ts 的 TOKEN_TTL_MS */
export const CODE_TTL_DAYS = 180;
const DAY = 86_400_000;

export interface LinkRow {
  id: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface LinkState {
  /** 有没有有效的连接码 */
  connected: boolean;
  /** 有效码里最晚一次被 Claude 用的时刻（毫秒）；没用过为 null */
  lastUsedMs: number | null;
  /** 有效码里最晚建的那个的时刻（毫秒），线框 s13“· 10/24 连接”；没连着为 null */
  madeMs: number | null;
}

const ms = (v: string | null): number | null => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/** 读到的行 → 连着没有、最后使用、最新一个码的建立时刻（纯函数） */
export function linkStateOf(rows: readonly LinkRow[], now: number): LinkState {
  let connected = false;
  let last: number | null = null;
  let newest: number | null = null;
  for (const r of rows) {
    const made = ms(r.created_at);
    if (r.revoked_at !== null || made === null || now - made >= CODE_TTL_DAYS * DAY) continue;
    connected = true;
    if (newest === null || made > newest) newest = made;
    const used = ms(r.last_used_at);
    if (used !== null && (last === null || used > last)) last = used;
  }
  return { connected, lastUsedMs: last, madeMs: newest };
}

export type LinkErr = 'offline' | 'failed' | 'too_many' | 'rate_limited' | 'signed_out';
export type LinkResult<T> = { ok: true; value: T } | { ok: false; err: LinkErr };

export interface NewCode {
  token: string;
  expiresAt: string | null;
}

export interface LinkDeps {
  list(signal: AbortSignal): Promise<{ data: unknown; error: unknown }>;
  revokeAll(signal: AbortSignal): Promise<{ error: unknown }>;
  create(signal: AbortSignal): Promise<Response | null>;
  online?(): boolean;
}

const LINK_COLS = 'id,created_at,last_used_at,revoked_at';

/** 生成连接码的请求（测试注入 fetch、令牌） */
export const createVia =
  (o: FnPostOptions = {}): LinkDeps['create'] =>
  (signal) =>
    sendFn('token-admin', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create' }) }, signal, o);

const defaultDeps: LinkDeps = {
  async list(signal) {
    const db = await getSupabase();
    return db.from('api_tokens').select(LINK_COLS).is('revoked_at', null).abortSignal(signal);
  },
  async revokeAll(signal) {
    const db = await getSupabase();
    // 值随便给一个非空的：触发器 guard_token_revoke 一律改成服务器的 now()
    return db.from('api_tokens').update({ revoked_at: new Date().toISOString() }).is('revoked_at', null).abortSignal(signal);
  },
  create: createVia(),
};

const isRow = (v: unknown): v is LinkRow => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const optStr = (x: unknown): boolean => x === null || typeof x === 'string';
  return typeof r['id'] === 'string' && typeof r['created_at'] === 'string' && optStr(r['last_used_at']) && optStr(r['revoked_at']);
};

async function timed<T>(d: LinkDeps, run: (signal: AbortSignal) => Promise<LinkResult<T>>): Promise<LinkResult<T>> {
  if (!(d.online ?? onlineNow)()) return { ok: false, err: 'offline' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LINK_TIMEOUT_MS);
  try {
    return await run(ac.signal);
  } catch (e) {
    return { ok: false, err: ac.signal.aborted || e instanceof TypeError ? 'offline' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** 读本人还没吊销的连接码 */
export function listLinks(d: LinkDeps = defaultDeps): Promise<LinkResult<LinkRow[]>> {
  return timed(d, async (signal) => {
    const r = await d.list(signal);
    if (r.error || !Array.isArray(r.data)) return { ok: false, err: signal.aborted ? 'offline' : 'failed' };
    return { ok: true, value: r.data.filter(isRow) };
  });
}

/** 生成一个连接码（明文只在这一次） */
export function createLink(d: LinkDeps = defaultDeps): Promise<LinkResult<NewCode>> {
  return timed(d, async (signal) => {
    const res = await d.create(signal);
    if (res === null) return { ok: false, err: 'signed_out' };
    if (res.status === 409) return { ok: false, err: 'too_many' };
    if (res.status === 429) return { ok: false, err: 'rate_limited' };
    if (!res.ok) return { ok: false, err: 'failed' };
    const b: unknown = await res.json();
    const r = typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
    if (typeof r['token'] !== 'string' || r['token'] === '') return { ok: false, err: 'failed' };
    return { ok: true, value: { token: r['token'], expiresAt: typeof r['expires_at'] === 'string' ? r['expires_at'] : null } };
  });
}

/** 断开连接：把还有效的码全吊销 */
export function disconnectAll(d: LinkDeps = defaultDeps): Promise<LinkResult<null>> {
  return timed(d, async (signal) => {
    const r = await d.revokeAll(signal);
    return r.error ? { ok: false, err: signal.aborted ? 'offline' : 'failed' } : { ok: true, value: null };
  });
}
