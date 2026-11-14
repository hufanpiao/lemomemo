// 一轮完整拉取（engine.ts 用）：config → 各同步表 → 墓碑 → 待补拉 → schema_v；另有退避等待的计算
// 一张表、墓碑、补拉失败：401（auth）、闸（stopped）照旧整轮停；别的（net）只跳过这一项、记 sync_pull_skip，接着拉后面的，整轮回 net
// 纯 TS：不准 import React 和任何功能（A1）
import { parseVersion, versionAtLeast } from '../../../shared/core/version.ts';
import { buildInfo } from '../../platform/env.ts';
import { applyFreshConfig, type BootResult } from '../boot.ts';
import type { Cache, CachedConfig, CachedProfile } from '../cache.ts';
import type { Outbox } from '../outbox-types.ts';
import { pullTable, pullTombstones, refetchTable, type PullDeps, type PullOutcome } from './pull.ts';
import { rlog } from '../../platform/run-log-api.ts';
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

/**
 * 同版本恢复（11-10 负责人手机 232 实测后的隐患 ②）：收到过 426 以后，队列暂停（meta outbox_pause）和挡（source 426 / queue）
 * 原来只有换了版本才解除；服务器把最低版本调低以后，同一个版本也一直挂着“需要更新才能继续同步”。
 * 这里只在**刚从服务器拉到**的 app_config 里 min_client_version 是合法版本号、本机版本 ≥ 它时解除：先解除挡，再 outbox.resume()（删暂停、
 * 重算状态；引擎订阅了状态，接着就发。顺序反了会在挡还在时 kick、被跳过，要等 30 秒定时才发）。配置没拉到、读失败、min 为空或不合法都不动（不能因为读不到配置就放行）。
 * 426 响应体里的 min 和 app_config 冲突时以刚拉到的 app_config 为准：服务器回 426 用的就是同一个 min_client_version（_shared/version-gate-core.ts，
 * 函数侧缓存最长 60 秒），426 里的是当时的旧值。万一服务器那边还没更新、又回 426，队列重新暂停，下一次拉到配置（启动、切回前台）再试，
 * 每次最多多发一个请求，不会自己循环
 */
export async function releaseUpgradePause(boot: BootResult, min: unknown, appVersion: string = buildInfo.version): Promise<void> {
  if (typeof min !== 'string' || !parseVersion(min) || !parseVersion(appVersion) || !versionAtLeast(appVersion, min)) return;
  const cur = boot.upgrade.getState().syncBlocked;
  let paused: boolean;
  try {
    // 内存里的状态和 meta 都看：状态还没重算时（刚启动）以 meta 为准
    paused = boot.outbox?.getStatus().paused != null || (boot.cache && !boot.cache.isClosed() ? (await boot.cache.getMeta('outbox_pause')) != null : false);
  } catch {
    return;   // 读不出 meta：当这次没解除，不让这一轮拉取失败（代码审 aae88d16 S1）
  }
  if (!paused && (!cur || cur.source === 'config')) return;
  boot.upgrade.checkMinVersion(min, true);
  try {
    if (boot.outbox) await boot.outbox.resume();
  } catch {
    // 删暂停失败：挡放回去（当这次没解除），这一轮照常拉；下一次拉到配置再试
    boot.upgrade.reportUpgradeRequired(cur?.min ?? min, cur?.source === '426' ? '426' : 'queue');
  }
}

/** 一轮完整拉取；返回 ok、auth（遇到 401）、net、stopped */
export async function pullRound(c: RoundCtx, transport: SyncTransport): Promise<PullOutcome> {
  if (c.withConfig) {
    const cfg = await transport.fetchConfig();
    if (c.d.gated()) return 'stopped';
    if (cfg.ok) {
      const fresh = toCached(cfg.value);
      await applyFreshConfig(c.boot, fresh);
      await releaseUpgradePause(c.boot, fresh.config?.min_client_version);
      c.withConfig = false;
    }
  }
  let out: PullOutcome = 'ok';
  /** 这一项的结果：ok 回 true；net 记日志、整轮记成 net、回 true（接着拉后面的）；auth、stopped 回 false（整轮停） */
  const go = (r: PullOutcome, coll: string): boolean => {
    if (r === 'ok') return true;
    if (r !== 'net') return false;
    out = 'net';
    c.d.log?.('sync_pull_skip', { coll, code: r });
    rlog(`sync pull_skip coll=${coll}`);
    return true;
  };
  for (const table of c.cache.syncTables) {
    const r = await pullTable(c.d, table, c.pendingFull.has(table));
    if (!go(r, table)) return r;
    if (r === 'ok') c.pendingFull.delete(table);
  }
  const tomb = await pullTombstones(c.d);
  if (!go(tomb, 'tombstones')) return tomb;
  if (!c.refetch.done) {
    let all = true;
    for (const [table, ids] of Object.entries(c.boot.refetch)) {
      if (!c.cache.syncTables.includes(table)) continue;
      const r = await refetchTable(c.d, table, ids);
      if (!go(r, table)) return r;
      all &&= r === 'ok';
    }
    c.refetch.done = all;   // 有一张没补拉成的，下一轮整份再补一次（已补到的再拉一次无害）
  }
  if (c.d.gated()) return 'stopped';
  if (out !== 'ok') return out;   // 有跳过的：不记 schema_v、不算这一轮拉完
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
