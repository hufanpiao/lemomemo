// 拉取（架构 4.3、0.29 续第 121、135 条）：增量、整表、待补拉、墓碑
// • 增量：synced_at >= 游标 − 10 分钟，按 (synced_at, id) 键集翻页；本机按 rev 合并（applyServer 忽略比本机旧的），多拉的不出问题
// • 整表：游标为空（第一次）、超过 25 天没整表同步、boot.fullResync（换账号、本机库迁移失败、SCHEMA_V 变了）、服务器拒收（rejected）；
//   拉第一页之前先快照本机 server 不为空的行（id → rev）；拉完以后只删“快照里有、这次没拉到、rev 没变”的行（dropServer 带上快照的 rev，
//   在同一个写事务里复查：rev 变了或这一行有 inflight 的项就不删）。拉取期间刚确认的 insert、别的标签页刚写的都不会被误删（K8 审查必改 2）
// • 翻页：只有“这一页不满”才算拉完；满 MAX_PAGES 页、或满页但取不到翻页位置 → 当作失败（net），不写游标、不删行，记错误码（K8 审查必改 6）
// • 墓碑：tombstones 按 deleted_at 增量拉（同样退 10 分钟），本机有这一行（或队列里有它的项）才删，没有的 id 一律忽略（L4）
// • 整行解析不了的 id 记进 meta 的 refetch:<表>（K7 的 read/ingest.ts updateRefetch：读成功的同时去掉；补拉时服务器已没有的 clearRefetch）
// 每处理一页之前先看闸；outbox 的方法封存后可能抛 CacheClosedError，由 engine.ts 当作“停下”
// 纯 TS：不准 import React 和任何功能（A1）
import type { Cache, SyncCursor } from '../cache.ts';
import { classifyFailure, recKey } from '../outbox-logic.ts';
import type { Outbox, SendFailure } from '../outbox-types.ts';
import { clearRefetch, updateRefetch } from '../read/ingest.ts';
import type { ParsedRows, ParseServerRows, SyncTransport, TombstoneRow } from './types.ts';

/** 增量拉取往回退 10 分钟（0.29 续第 135 条） */
export const PULL_LOOKBACK_MS = 10 * 60 * 1000;
/** 超过 25 天没整表同步就整表重拉（4.3） */
export const FULL_RESYNC_AFTER_MS = 25 * 24 * 60 * 60 * 1000;
export const PAGE_SIZE = 500;
/** 一次拉取最多翻多少页（防死循环；正常远远到不了） */
export const MAX_PAGES = 400;
export const TOMBSTONE_CURSOR = 'cursor:tombstones' as const;

export interface PullDeps {
  cache: Cache;
  outbox: Outbox;
  transport: SyncTransport;
  parseRows: ParseServerRows;
  gated(): boolean;
  now(): number;
  /** 记错误码（不记内容） */
  log?(code: string): void;
  /** 测试用：每页行数、最多页数 */
  pageSize?: number;
  maxPages?: number;
}

/** 拉取的结果：ok；net 网络或服务器出错（游标不动，下次再拉）；auth 令牌过期（401，调用方刷新一次再拉）；stopped 闸设上了 */
export type PullOutcome = 'ok' | 'net' | 'auth' | 'stopped';

/** 拉取失败：401 交给调用方刷新令牌，别的一律 net */
const failed = (e: SendFailure): PullOutcome => (classifyFailure(e) === 'auth' ? 'auth' : 'net');

/** 游标往回退 10 分钟；解析不了就整表拉（返回 null） */
export function lookback(cursor: string, ms: number = PULL_LOOKBACK_MS): string | null {
  const t = Date.parse(cursor);
  return Number.isFinite(t) ? new Date(t - ms).toISOString() : null;
}

/** 两个 timestamptz 原文哪个晚（按毫秒比；相同毫秒取字符串大的，微秒位数相同时等价于比微秒） */
function later(a: string | null, b: string): string {
  if (a === null) return b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(tb)) return a;
  if (!Number.isFinite(ta) || tb > ta) return b;
  return tb === ta && b > a ? b : a;
}

export function needsFull(cur: SyncCursor | undefined, now: number): boolean {
  return !cur || cur.cursor === null || cur.fullSyncAt === null || now - cur.fullSyncAt > FULL_RESYNC_AFTER_MS;
}

/**
 * 待补拉列表（K7 的 updateRefetch，一个 meta 事务里读改写）：加上这次解析不了的，去掉这次读成功的。
 * 照 read/ingest.ts：remove = rows 的 id − bad − skipped（applyServer 没收的：比本机旧、没过空壳门槛、本机没有的空壳，不算读成功）
 */
export async function rememberBad(cache: Cache, table: string, parsed: ParsedRows, skipped: readonly string[] = []): Promise<void> {
  const keep = new Set([...parsed.bad, ...skipped]);
  await updateRefetch(cache, table, parsed.bad, parsed.rows.map((r) => r.row.id).filter((id) => !keep.has(id)));
}

/** 宽容读取后的行写进本机（applyServer），再按它没收的（skipped）更新待补拉 */
async function ingest(d: Pick<PullDeps, 'cache' | 'outbox'>, table: string, parsed: ParsedRows): Promise<void> {
  const skipped = parsed.rows.length ? ((await d.outbox.applyServer(table, parsed.rows))?.skipped ?? []) : [];
  await rememberBad(d.cache, table, parsed, skipped);
}

/** 拉一张同步表（增量或整表） */
export async function pullTable(d: PullDeps, table: string, forceFull = false): Promise<PullOutcome> {
  const key = `cursor:${table}` as const;
  const cur = await d.cache.getMeta(key);
  const full = forceFull || needsFull(cur, d.now());
  const since = full || !cur?.cursor ? null : lookback(cur.cursor);
  const startedAt = d.now();
  const size = d.pageSize ?? PAGE_SIZE;
  const seen = new Set<string>();
  // 整表：游标从头算（旧游标可能比服务器的还新）；拉第一页之前快照本机已上服务器的行
  let maxSynced: string | null = full ? null : (cur?.cursor ?? null);
  const snapshot = full ? await snapshotRevs(d.cache, table) : null;
  let after: { synced_at: string; id: string } | null = null;
  let complete = false;
  for (let page = 0; page < (d.maxPages ?? MAX_PAGES); page++) {
    if (d.gated()) return 'stopped';
    const res = await d.transport.pullRows(table, { since: full ? null : since, after, limit: size });
    if (d.gated()) return 'stopped';
    if (!res.ok) return failed(res.error);
    const raw = res.value;
    const parsed = d.parseRows(table, raw);
    await ingest(d, table, parsed);
    let last: { synced_at: string; id: string } | null = null;
    for (const r of raw) {
      if (typeof r !== 'object' || r === null) continue;
      const o = r as Record<string, unknown>;
      if (typeof o['id'] !== 'string') continue;
      seen.add(o['id']);
      if (typeof o['synced_at'] === 'string') {
        maxSynced = later(maxSynced, o['synced_at']);
        last = { synced_at: o['synced_at'], id: o['id'] };
      }
    }
    if (raw.length < size) {
      complete = true;
      break;
    }
    if (!last) {
      d.log?.('sync_page_no_cursor');   // 满页却取不到翻页位置：不能当拉完
      return 'net';
    }
    after = last;
  }
  if (!complete) {
    d.log?.('sync_max_pages');
    return 'net';
  }
  if (snapshot) {
    if (d.gated()) return 'stopped';
    const expect = new Map([...snapshot].filter(([id]) => !seen.has(id)));
    if (expect.size) await d.outbox.dropServer(table, [...expect.keys()], expect);
  }
  if (d.gated()) return 'stopped';
  await d.cache.setMeta(key, { cursor: maxSynced, fullSyncAt: full ? startedAt : (cur?.fullSyncAt ?? null) });
  return 'ok';
}

/** 整表重拉开始前：本机已上服务器的行（server 不为空）的 id → rev */
async function snapshotRevs(cache: Cache, table: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await cache.allRows(table)) {
    const rev = r.server?.['rev'];
    if (r.server !== null) out.set(r.id, typeof rev === 'number' ? rev : -1);
  }
  return out;
}

/** 单独补拉 K7 记下的 id（拉到的照常合并；服务器上已经没有的交给墓碑和整表重拉） */
export async function refetchTable(d: PullDeps, table: string, ids: readonly string[]): Promise<PullOutcome> {
  if (ids.length === 0) return 'ok';
  if (d.gated()) return 'stopped';
  const res = await d.transport.fetchByIds(table, ids);
  if (d.gated()) return 'stopped';
  if (!res.ok) return failed(res.error);
  const parsed = d.parseRows(table, res.value);
  await ingest(d, table, parsed);   // 读成功的去掉，还解析不了的、没收的留着
  // 服务器上已经没有的（硬删、30 天清理）：从待补拉列表去掉，不然每次启动都去拉（K7 的 clearRefetch）
  const returned = new Set(res.value.flatMap((r) => (typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string' ? [(r as { id: string }).id] : [])));
  const missing = ids.filter((id) => !returned.has(id));
  if (missing.length) await clearRefetch(d.cache, table, missing);
  return 'ok';
}

export function asTombstone(raw: unknown): TombstoneRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const { tbl, id, deleted_at } = o;
  if (typeof tbl !== 'string' || typeof id !== 'string' || typeof deleted_at !== 'string') return null;
  return { tbl, id, deleted_at };
}

/** 收到墓碑：本机有这一行或队列里有它的项才删（含 server、view 两份和还没发的项）；别的 id 一律忽略（L4） */
export async function applyTombstones(d: Pick<PullDeps, 'cache' | 'outbox' | 'gated'>, rows: readonly TombstoneRow[]): Promise<void> {
  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    if (!d.cache.syncTables.includes(r.tbl)) continue;
    const list = byTable.get(r.tbl) ?? [];
    list.push(r.id);
    byTable.set(r.tbl, list);
  }
  if (byTable.size === 0) return;
  const queued = new Set((await d.outbox.list()).map((i) => i.rec));
  for (const [table, ids] of byTable) {
    if (d.gated()) return;
    const known: string[] = [];
    for (const id of new Set(ids)) {
      if (queued.has(recKey(table, id)) || (await d.cache.getRow(table, id))) known.push(id);
    }
    if (known.length) await d.outbox.dropServer(table, known);
  }
}

/** 增量拉墓碑 */
export async function pullTombstones(d: PullDeps): Promise<PullOutcome> {
  const cur = await d.cache.getMeta(TOMBSTONE_CURSOR);
  const since = cur?.cursor ? lookback(cur.cursor) : null;
  let maxAt: string | null = cur?.cursor ?? null;
  let after: { deleted_at: string; tbl: string; id: string } | null = null;
  const size = d.pageSize ?? PAGE_SIZE;
  let complete = false;
  for (let page = 0; page < (d.maxPages ?? MAX_PAGES); page++) {
    if (d.gated()) return 'stopped';
    const res = await d.transport.pullTombstones({ since, after, limit: size });
    if (d.gated()) return 'stopped';
    if (!res.ok) return failed(res.error);
    const rows = res.value.map(asTombstone).filter((r): r is TombstoneRow => r !== null);
    await applyTombstones(d, rows);
    for (const r of rows) maxAt = later(maxAt, r.deleted_at);
    const last = rows[rows.length - 1];
    if (res.value.length < size) {
      complete = true;
      break;
    }
    if (!last) {
      d.log?.('sync_page_no_cursor');
      return 'net';
    }
    after = { deleted_at: last.deleted_at, tbl: last.tbl, id: last.id };
  }
  if (!complete) {
    d.log?.('sync_max_pages');
    return 'net';
  }
  if (d.gated()) return 'stopped';
  await d.cache.setMeta(TOMBSTONE_CURSOR, { cursor: maxAt, fullSyncAt: cur?.fullSyncAt ?? null });
  return 'ok';
}

/** Realtime 来的一行（INSERT / UPDATE）：宽容读取后合并；不是同步表的忽略 */
export async function applyRealtimeRow(d: PullDeps, table: string, raw: unknown): Promise<void> {
  if (!d.cache.syncTables.includes(table)) return;
  const p = d.parseRows(table, [raw]);
  await ingest(d, table, p);
}

/** Realtime 来的墓碑（INSERT） */
export async function applyRealtimeTombstone(d: PullDeps, raw: unknown): Promise<void> {
  const t = asTombstone(raw);
  if (t) await applyTombstones(d, [t]);
}
