// 一轮完整拉取（engine.ts 用）：config → 各同步表 → 墓碑 → 待补拉 → schema_v；另有退避等待的计算
// 纯 TS：不准 import React 和任何功能（A1）
import { applyFreshConfig, type BootResult } from '../boot.ts';
import type { Cache, CachedConfig, CachedProfile } from '../cache.ts';
import type { Outbox } from '../outbox-types.ts';
import { pullTable, pullTombstones, refetchTable, type PullDeps, type PullOutcome } from './pull.ts';
import type { ConfigRows, SyncTransport } from './types.ts';

export interface RoundCtx {
  boot: BootResult;
  cache: Cache;
  d: PullDeps;
  /** 要整表重拉的表（拉成功就删掉） */
  pendingFull: Set<string>;
  /** boot.refetch 只补拉一次 */
  refetch: { done: boolean };
  /** 这一轮要先刷新 app_config / profiles（拉成功就置 false） */
  withConfig: boolean;
  schemaV: number;
}

/** 服务器的 app_config、profiles 行 → 本机缓存的形状（profiles 以 user_id 为 id） */
export function toCached(r: ConfigRows): { config?: CachedConfig; profile?: CachedProfile } {
  const out: { config?: CachedConfig; profile?: CachedProfile } = {};
  if (r.config) out.config = { ...r.config } as CachedConfig;
  const p = r.profile as Record<string, unknown> | null;
  if (p && typeof p['user_id'] === 'string') out.profile = { ...p, id: p['user_id'] } as CachedProfile;
  return out;
}

/** 一轮完整拉取；返回 ok、auth（遇到 401）、net、stopped */
export async function pullRound(c: RoundCtx, transport: SyncTransport): Promise<PullOutcome> {
  if (c.withConfig) {
    const cfg = await transport.fetchConfig();
    if (c.d.gated()) return 'stopped';
    if (cfg.ok) {
      await applyFreshConfig(c.boot, toCached(cfg.value));
      c.withConfig = false;
    }
  }
  for (const table of c.cache.syncTables) {
    const r = await pullTable(c.d, table, c.pendingFull.has(table));
    if (r !== 'ok') return r;
    c.pendingFull.delete(table);
  }
  const tomb = await pullTombstones(c.d);
  if (tomb !== 'ok') return tomb;
  if (!c.refetch.done) {
    for (const [table, ids] of Object.entries(c.boot.refetch)) {
      if (!c.cache.syncTables.includes(table)) continue;
      const r = await refetchTable(c.d, table, ids);
      if (r !== 'ok') return r;
    }
    c.refetch.done = true;
  }
  if (c.d.gated()) return 'stopped';
  // 整表重拉全部完成：记下当前的 rows.ts 版本（boot.ts 的 fullResync 说明）
  if (c.pendingFull.size === 0 && (await c.cache.getMeta('schema_v')) !== c.schemaV) await c.cache.setMeta('schema_v', c.schemaV);
  return 'ok';
}

/** 退避中最早到点的那一项还要等多久（毫秒，多等 50 毫秒）；没有在退避的返回 null */
export async function retryDelay(outbox: Outbox, t: number): Promise<number | null> {
  const waits = (await outbox.list()).filter((i) => i.state === 'pending' && i.next_at > t).map((i) => i.next_at);
  return waits.length ? Math.min(...waits) - t + 50 : null;
}

/**
 * 记下这件活写过哪些表（主页据此给别的页面发 changed，4.3b）：拦 outbox 的 applyServer、dropServer、next（发出去的项确认后会改本机行）
 */
export function trackTables(outbox: Outbox, touched: Set<string>): Outbox {
  const o = Object.create(outbox) as Outbox;
  o.applyServer = (table, rows) => {
    if (rows.length) touched.add(table);
    return outbox.applyServer(table, rows);
  };
  o.dropServer = (table, ids, expect) => {
    if (ids.length) touched.add(table);
    return outbox.dropServer(table, ids, expect);
  };
  o.next = async () => {
    const item = await outbox.next();
    if (item) touched.add(item.table);
    return item;
  };
  return o;
}
