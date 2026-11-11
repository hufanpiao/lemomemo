// “最近删除”的永久删除和全部清空（B4 S9；TC-B4-17；架构 0.29 续第 121 条 ②⑤⑧，R-180）
// • 只走 RPC purge_deleted（0001_core.sql、20261029191000）：客户端没有 REST DELETE 权限，也不进 outbox（要联网，离线直接回 offline）
//   - 单条：p_items = [{tbl, id}]；服务器只删本人、已在“最近删除”里的行，回删掉的条数
//   - 全部清空：也只传列表里看得见的那些 [{tbl, id}]，不传 null（null 会把服务器上所有已删除的行都清掉，
//     包括本机刚恢复、恢复还没发上去的那条，代码审 11-11 必改）；服务器一次最多 500 项（too_many_items），超过分批发
// • 判成功按回来的条数：单条回 0 = 服务器上它还没算删除（离线删的、删除还没发上去），回 not_synced，不能当成功；
//   分批时每批单独判断：回的条数等于这批的项数，这批每一项都删掉了（id 不重复）；少了就不知道是哪几项，这批一项都不算删掉
// • serverDeleted：按本机缓存里服务器那一份（CachedRow.server）判断每一项在服务器上是不是已经删除，
//   没删除的（删除还没发上去）全部清空时不发、不算进确认框的条数
// • 本机的行不在这里删：服务器删行写墓碑，同步拉到墓碑再删本机这一行（0.29 续第 121 条⑤）
// • 8 秒超时；只在“最近删除”页（懒加载块）里用，不进首屏
// 纯 TS：不准 import React（A1）
import { getBoot } from '../../../core/boot.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';

export type PurgeTable = 'events' | 'todos' | 'notes';
export type PurgeErr = 'offline' | 'failed' | 'not_synced';
export type PurgeResult = { ok: true; n: number } | { ok: false; err: PurgeErr };

export type PurgeKey = { tbl: PurgeTable; id: string };
export interface PurgeManyResult {
  /** 确认删掉了的项 */
  done: PurgeKey[];
  /** 发了、但回的条数对不上的项数（不知道是哪几项，一项都不藏） */
  left: number;
  /** 中途出错就停下，后面的批不发 */
  err: PurgeErr | null;
}

export const PURGE_TIMEOUT_MS = 8000;
export const PURGE_BATCH = 500;

export interface PurgeDeps {
  rpc(items: readonly PurgeKey[], signal: AbortSignal): Promise<{ data: unknown; error: unknown }>;
  online?(): boolean;
}

const defaultDeps: PurgeDeps = {
  async rpc(items, signal) {
    const db = await getSupabase();
    return db.rpc('purge_deleted', { p_items: items.map((i) => ({ tbl: i.tbl, id: i.id })) }).abortSignal(signal);
  },
};

const offlineNow = (d: PurgeDeps): boolean => (d.online ? !d.online() : typeof navigator !== 'undefined' && navigator.onLine === false);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

async function call(items: readonly PurgeKey[], d: PurgeDeps, timeoutMs: number): Promise<PurgeResult> {
  if (offlineNow(d)) return { ok: false, err: 'offline' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await d.rpc(items, ac.signal);
    if (r.error) return { ok: false, err: ac.signal.aborted ? 'offline' : 'failed' };
    const n = count(r.data);
    return n === null ? { ok: false, err: 'failed' } : { ok: true, n };
  } catch (e) {
    return { ok: false, err: ac.signal.aborted || e instanceof TypeError ? 'offline' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** 永久删除一条；服务器回 0 条时报 not_synced */
export async function purgeOne(table: PurgeTable, id: string, d: PurgeDeps = defaultDeps, timeoutMs = PURGE_TIMEOUT_MS): Promise<PurgeResult> {
  const r = await call([{ tbl: table, id }], d, timeoutMs);
  return r.ok && r.n === 0 ? { ok: false, err: 'not_synced' } : r;
}

/** 全部清空：按 PURGE_BATCH 分批传 [{tbl, id}]，每批按条数单独判断 */
export async function purgeMany(items: readonly PurgeKey[], d: PurgeDeps = defaultDeps, timeoutMs = PURGE_TIMEOUT_MS, batch = PURGE_BATCH): Promise<PurgeManyResult> {
  const done: PurgeKey[] = [];
  let left = 0;
  for (let at = 0; at < items.length; at += batch) {
    const part = items.slice(at, at + batch);
    const r = await call(part, d, timeoutMs);
    if (!r.ok) return { done, left, err: r.err };
    if (r.n === part.length) done.push(...part);
    else left += part.length;
  }
  return { done, left, err: null };
}

const deletedIn = async (items: readonly PurgeKey[], side: 'server' | 'view'): Promise<boolean[]> => {
  const cache = getBoot()?.cache;
  return Promise.all(
    items.map(async (i) => {
      const r = await cache?.getRow(i.tbl, i.id).catch(() => undefined);
      return r?.[side]?.['deleted_at'] != null && (side === 'view' || r.view?.['deleted_at'] != null);
    }),
  );
};

/**
 * 每一项能不能发去永久删除：本机缓存里服务器那一份已删除，并且本机这一份也还是已删除
 * （刚点了恢复、恢复还没发上去的，本机这一份已经不是删除了，不发；代码复审 11-11）；读不到缓存当不能发
 */
export function serverDeleted(items: readonly PurgeKey[]): Promise<boolean[]> {
  return deletedIn(items, 'server');
}

/** 本机这一份还是不是已删除（单条永久删除发请求前核：等恢复写完以后它可能已经恢复了） */
export function localDeleted(items: readonly PurgeKey[]): Promise<boolean[]> {
  return deletedIn(items, 'view');
}
