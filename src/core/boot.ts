// 离线冷启动（架构 4.1“启动时先用缓存渲染”、0.27 第 1、4 点）：入口在渲染 App 之前调 coldStart()，不等网络
// 1. 打开本机库（建库、升级、迁移；VersionError → 整屏提示，不删库；被挡住 → 等 BLOCKED_PROMPT_DELAY_MS 仍没打开才提示关掉其他窗口）
// 2. 换账号就清空整库（core/account.ts，比对和清空在一个事务里）；迁移失败时按 outbox 重建 view（M5）；
//    清掉 deleted_at 早于 30 天的行（4.3 第①条的本机第二道）
// 3. 把各同步仓的 view 灌进 core/store 的集合（界面先画上次的内容，顶部“正在同步…”由同步层管）
// 4. 整理离线队列（队列项迁移、inflight 复位、版本变了就解除 426 暂停）
// 5. 读 meta 的 config、profile，按 featureOn 算出这台设备离线时该挂哪些功能入口（TC-B1-50）
// 6. 按缓存的 min_client_version、没解除的 426 暂停、“刚按过更新”判断是否挡同步
// 返回给 K7（宽容读取：待补拉 id）和 K8（同步：要整表重拉的表、outbox、upgrade）用
// 失败即关（M3）：开库之后任何一步抛错，都关库、清掉内存集合，按 unavailable 返回（不渲染缓存，只联网用）；coldStart 本身不抛
// 纯 TS：不准 import React 和任何功能（A1）
import { featureOn } from '../../shared/logic/flags.ts';
import { SCHEMA_V } from '../../shared/schema/rows.ts';
import { buildInfo } from '../platform/env.ts';
import { onUpgradeRequired } from '../platform/http.ts';
import { clearCacheStorage } from '../platform/session.ts';
import { reloadPage, updateAttemptStore, updateServiceWorker } from '../platform/sw-register.ts';
import { ensureAccount } from './account.ts';
import { deleteCacheDb, openCache, VERSION_CLOSE_WAIT_MS, type Cache, type CachedConfig, type CachedProfile, type CachedRow, type OpenCacheOptions, type OpenCacheResult } from './cache.ts';
import type { UpgradeReport } from './cache-migrations.ts';
import { DRAFTS, OUTBOX, PENDING_ACTIONS, VAULT_DRAFTS } from './cache-schema.ts';
import { createOutbox, type Outbox, type OutboxBootReport, type OutboxItem, type OutboxOptions } from './outbox.ts';
import { rewriteRow } from './outbox-rows.ts';
import { clearAllCollections, collection } from './store.ts';
import { createUpgradeCenter, type UpgradeCenter, type UpgradeDeps } from './upgrade.ts';

/** 软删除的行在本机最多留 30 天（和服务器的 30 天清理同一规则） */
export const LOCAL_PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 升级本机库收到 blocked 后，等这么久仍没打开才提示（文案见 update.blocked.title）。
 * 配合升级的标签页（监听了 onversionchange）先写草稿再关库，最多等 VERSION_CLOSE_WAIT_MS，这期间浏览器（chromium、webkit 实测）
 * 会先报 1 次 blocked；马上提示会闪一下。多留 500 ms 余量；真有没配合的旧页一直占着库，到时照样提示
 */
export const BLOCKED_PROMPT_DELAY_MS = VERSION_CLOSE_WAIT_MS + 500;

export interface BootOptions {
  /** 当前登录的账号（platform/session.ts 的 readSessionUserId，离线也能读）；没登录为 null：不建本机库，直接返回 signed_out */
  userId: string | null;
  /** 换账号时清 Cache Storage；默认 platform/session.ts 的 clearCacheStorage */
  clearCacheStorage?: () => Promise<void>;
  appVersion?: string;
  now?: () => number;
  /** 测试用：换库名、换 IDBFactory、换迁移表 */
  cacheOptions?: OpenCacheOptions;
  /**
   * 本机库被别处按库名删掉（别的标签页退出登录，versionchange 的 newVersion 为 null）时调；main.tsx 传：
   * 同步读一次会话，没有会话就回登录页，还有（别的标签页已经重新登录）就重新载入
   */
  onCacheDeleted?: () => void;
  outboxOptions?: Omit<OutboxOptions, 'appVersion' | 'now'>;
  /** 测试用：换掉重新载入、SW 更新、sessionStorage */
  upgradeDeps?: Partial<UpgradeDeps>;
  /** 默认 shared/schema/rows.ts 的 SCHEMA_V */
  schemaV?: number;
  /** 默认 true：经 platform/http.ts 订阅所有请求的 426 */
  listen426?: boolean;
  /**
   * 升级中心一建好就同步调（在开库之前）：main.tsx 用它盯 blocked（整屏提示，文案见 update.blocked.title）——
   * 被挡住时 coldStart 还在等库打开，App 还没画（架构师 10-30 第 8 点）
   */
  onUpgradeCenter?: (upgrade: UpgradeCenter) => void;
}

export type BootStatus =
  /** 没登录：没打开、没建本机库；入口跳到 /app/auth/ */
  | 'signed_out'
  /** 本机库可用（可能是空的） */
  | 'ready'
  /** 本机库来自更新的版本：整屏提示“这台设备上的数据来自更新的版本，请更新柠檬记” */
  | 'version_too_new'
  /** 没有 IndexedDB 或打开出错：照样能联网用，只是没有离线（记错误码） */
  | 'unavailable';

export interface BootResult {
  status: BootStatus;
  /** 启动时会话里的账号（signed_out 时为 null）；watchAccount 拿它和之后的会话比 */
  userId: string | null;
  /**
   * 换账号的闸（core/account.ts 的 watchAccount 同步设上）：为 true 时 K8 不再发送、不再写回服务器来的数据，
   * 之后马上关库、重新载入。outbox 同时 suspend()
   */
  switching: boolean;
  cache: Cache | null;
  outbox: Outbox | null;
  upgrade: UpgradeCenter;
  /** 上次缓存的 app_config（本人能读的列） */
  config: CachedConfig | null;
  /** 上次缓存的 profiles 本人那一行 */
  profile: CachedProfile | null;
  /**
   * 按缓存算出的、对本人打开的功能开关（featureOn：on、beta_features、min_client）。
   * null = 本机没有缓存的 config（第一次打开）：入口按默认全挂，联网拿到 config 再算
   */
  flags: ReadonlySet<string> | null;
  /**
   * K8 要整表重拉的表：本机库迁移失败（可重拉的仓已清空）、换了账号、或 rows.ts 的 SCHEMA_V 变了（TC-B1-40）。
   * 整表重拉全部完成后，K8 写 setMeta('schema_v', SCHEMA_V)
   */
  fullResync: readonly string[];
  /** K7 记下的“待补拉”id（按表）：K8 联网后单独补拉 */
  refetch: Readonly<Record<string, readonly string[]>>;
  /** 换了账号，已清空整库 */
  switchedUser: boolean;
  /** 本次清掉的过期软删除行数 */
  purged: number;
  upgradeReport: UpgradeReport | null;
  outboxReport: OutboxBootReport | null;
  /** 打不开库、或启动中途出错（已降级成 unavailable）时的错误名 */
  error: string | null;
}

/** 按缓存的 config、profile 算出对本人打开的开关；config 没有 features 时返回 null */
export function enabledFlags(config: CachedConfig | null, profile: CachedProfile | null, appVersion: string): ReadonlySet<string> | null {
  const features = config?.features;
  if (!features) return null;
  const ctx = { beta: profile?.beta_features ?? [], appVersion };
  return new Set(Object.keys(features).filter((k) => featureOn(features, k, ctx)));
}

/** 退出登录、换账号、被移除：清空整个本机库和内存里的集合（Cache Storage、推送订阅由调用方另清；install_id 不在这里） */
export async function wipeLocal(cache: Cache): Promise<void> {
  await cache.clearAll();
  clearAllCollections();
}

let current: BootResult | null = null;
let off426: (() => void) | null = null;
/** 正在等的 blocked 提示计时器（打开成功、出错、重新 coldStart、resetBootForTest 时取消） */
let cancelBlockedPrompt: (() => void) | null = null;

/**
 * 本机还没上传的东西有几条（K9 退出登录前提示“还有 N 条没同步，退出会丢掉”；A18 不许 vault 代码 import cache，所以由 core 数）：
 * 先 outbox.refresh()，再数 outbox 的全部项（待发 + 正在发 + 发送失败）+ drafts + vault_drafts + pending_actions。
 * 没启动、outbox 为 null、库已关、已封存、读失败，都返回 null（数不出来，调用方按“不确定”提示）
 */
export async function localUnsentCount(boot: BootResult | null = current): Promise<number | null> {
  const cache = boot?.cache;
  const outbox = boot?.outbox;
  if (!cache || !outbox || cache.isClosed() || cache.isSealed()) return null;
  try {
    await outbox.refresh();
    const stores = [OUTBOX, DRAFTS, VAULT_DRAFTS, PENDING_ACTIONS];
    return await cache.tx(stores, 'readonly', async (t) => {
      let n = 0;
      for (const s of stores) n += (await t.getAll(s)).length;
      return n;
    });
  } catch {
    return null;
  }
}

/** 最近一次 coldStart 的结果（K7、K8、UI hooks 从这里拿 cache、outbox、upgrade）；还没启动为 null */
export function getBoot(): BootResult | null {
  return current;
}

/** 测试之间清掉 */
export function resetBootForTest(): void {
  current = null;
  off426?.();
  off426 = null;
  cancelBlockedPrompt?.();
}

function defaultUpgradeDeps(appVersion: string, partial: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    appVersion,
    reload: reloadPage,
    swUpdate: updateServiceWorker,
    attempt: updateAttemptStore,
    ...partial,
  };
}

export async function coldStart(opts: BootOptions): Promise<BootResult> {
  const appVersion = opts.appVersion ?? buildInfo.version;
  const now = opts.now ?? (() => Date.now());
  const upgrade = createUpgradeCenter(defaultUpgradeDeps(appVersion, opts.upgradeDeps));
  opts.onUpgradeCenter?.(upgrade);
  off426?.();
  off426 = opts.listen426 !== false ? onUpgradeRequired((u) => upgrade.reportUpgradeRequired(u.min)) : null;

  const result: BootResult = {
    status: 'unavailable',
    userId: opts.userId,
    switching: false,
    cache: null,
    outbox: null,
    upgrade,
    config: null,
    profile: null,
    flags: null,
    fullResync: [],
    refetch: {},
    switchedUser: false,
    purged: 0,
    upgradeReport: null,
    outboxReport: null,
    error: null,
  };
  current = result;
  if (!opts.userId) {
    // 没有会话但库还在（别的标签页退出时本页没来得及清、或退出途中关掉了页面）：按库名删掉，不留上一个账号的数据（登录页审查）；
    // 库里还没同步的修改一起丢（R-231 负责人已接受）。
    // 版本比本 App 高的库（v99 一类、TC-B1-49 的 version_too_new）也照样删：TC-B1-49 管的是“有会话时不删、只提示更新”，
    // 没有会话时库里的数据本来就该清掉，两者不矛盾
    result.status = 'signed_out';
    await deleteCacheDb({ factory: opts.cacheOptions?.factory, name: opts.cacheOptions?.name });
    return result;
  }
  const userId = opts.userId;
  let opened: OpenCacheResult | null = null;
  // blocked 不马上提示：等 BLOCKED_PROMPT_DELAY_MS 仍没打开才 setBlocked(true)（配合升级的页关库期间浏览器会先报一次 blocked）
  cancelBlockedPrompt?.();
  let blockedTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelThis = (): void => {
    if (blockedTimer !== null) clearTimeout(blockedTimer);
    blockedTimer = null;
    if (cancelBlockedPrompt === cancelThis) cancelBlockedPrompt = null;
  };
  cancelBlockedPrompt = cancelThis;
  try {
    opened = await openCache({
      ...opts.cacheOptions,
      onBlocked: () => {
        opts.cacheOptions?.onBlocked?.();
        if (blockedTimer !== null || cancelBlockedPrompt !== cancelThis) return;
        blockedTimer = setTimeout(() => {
          blockedTimer = null;
          upgrade.setBlocked(true);
        }, BLOCKED_PROMPT_DELAY_MS);
      },
    });
    cancelThis();
    upgrade.setBlocked(false);
    if (!opened.ok) {
      result.error = opened.error;
      if (opened.reason === 'version_too_new') {
        result.status = 'version_too_new';
        upgrade.setCacheTooNew();
        // 刚按过“去更新”而库仍比 App 新 → still_old，并清掉 lemo.update_attempt 标记（复审 S3）
        upgrade.afterReloadCheck();
      }
      return result;
    }
    await loadCache(result, opened.cache, opened.upgrade, userId, opts, appVersion, now);
    result.status = 'ready';
    return result;
  } catch (e) {
    cancelThis();
    // 失败即关：不渲染半截的缓存
    if (opened?.ok) {
      try {
        opened.cache.close();
      } catch {
        // 已关
      }
    }
    clearAllCollections();
    Object.assign(result, {
      status: 'unavailable', cache: null, outbox: null, config: null, profile: null, flags: null,
      fullResync: [], refetch: {}, purged: 0, error: errName(e),
    } satisfies Partial<BootResult>);
    return result;
  }
}

function errName(e: unknown): string {
  return e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException) ? e.name : 'error';
}

/** 迁移失败后同步仓被重建（空的）：按 outbox 里还在的项重算 view，本机还没发出的 insert 在界面上照样看得见（M5） */
async function rebuildViewsFromOutbox(cache: Cache): Promise<void> {
  const tables = new Set(cache.syncTables);
  await cache.tx([...tables, OUTBOX], 'readwrite', async (t) => {
    const seen = new Set<string>();
    for (const i of await t.getAll<OutboxItem>(OUTBOX)) {
      if (seen.has(i.rec) || !tables.has(i.table)) continue;
      seen.add(i.rec);
      await rewriteRow(t, i.table, i.id, await t.get<CachedRow>(i.table, i.id));
    }
  });
}

/** 开库以后的各步；任何一步抛错由 coldStart 统一降级 */
async function loadCache(
  result: BootResult,
  cache: Cache,
  report: UpgradeReport,
  userId: string,
  opts: BootOptions,
  appVersion: string,
  now: () => number,
): Promise<void> {
  const upgrade = result.upgrade;
  result.cache = cache;
  result.upgradeReport = report;
  cache.onClosed((reason) => {
    if (reason === 'versionchange') upgrade.onCacheVersionChange();
    // 别处在删库（别的标签页退出登录）：不走升级的重新载入、不出“有新版本”提示，交给入口看会话（K6 复审 C）
    if (reason === 'deleted') opts.onCacheDeleted?.();
  });

  // 换账号（4.1、0.38 第 17 条）：在读写任何东西之前比对 owner，不同就清空整库和运行时缓存，旧账号的 outbox 不发
  result.switchedUser = await ensureAccount(cache, userId, { clearCacheStorage: opts.clearCacheStorage ?? clearCacheStorage });

  // 日志：仓库里还没有日志层（core/log），outbox 的 log（R-229 outbox_vault_shell_drop）暂不接；接上以后经 opts.outboxOptions.log 传进来（接手清单 K6-log）
  const outbox = createOutbox(cache, { ...opts.outboxOptions, appVersion, now });
  result.outbox = outbox;
  result.outboxReport = await outbox.boot();
  outbox.onEvent((e) => {
    if (e.type === 'upgrade_required') upgrade.reportUpgradeRequired(e.min);
  });

  if (report.failed) await rebuildViewsFromOutbox(cache);

  // 灌集合，顺带清掉过期的软删除行（队列里还有它的项的不动）
  const cutoff = now() - LOCAL_PURGE_AFTER_MS;
  const queued = new Set((await cache.tx([OUTBOX], 'readonly', (t) => t.getAll<OutboxItem>(OUTBOX))).map((i) => i.rec));
  for (const table of cache.syncTables) {
    const rows = await cache.allRows(table);
    const expired: string[] = [];
    const keep: CachedRow[] = [];
    for (const r of rows) {
      const del = r.server?.['deleted_at'];
      if (typeof del === 'number' && del < cutoff && !queued.has(`${table}:${r.id}`)) expired.push(r.id);
      else keep.push(r);
    }
    if (expired.length) await cache.deleteRows(table, expired);
    result.purged += expired.length;
    const views = keep.flatMap((r) => (r.view ? [r.view] : []));
    if (views.length) collection(table).upsert(views);
  }

  // 要整表重拉的表
  const schemaV = opts.schemaV ?? SCHEMA_V;
  const storedV = await cache.getMeta('schema_v');
  if (report.failed || result.switchedUser || (storedV !== undefined && storedV !== schemaV)) result.fullResync = [...cache.syncTables];

  // K7 记下的待补拉
  const refetch: Record<string, readonly string[]> = {};
  for (const table of cache.syncTables) {
    const ids = await cache.getMeta(`refetch:${table}`);
    if (ids?.length) refetch[table] = ids;
  }
  result.refetch = refetch;

  // 功能入口（离线也按上次缓存的结果挂）
  result.config = (await cache.getMeta('config')) ?? null;
  result.profile = (await cache.getMeta('profile')) ?? null;
  result.flags = enabledFlags(result.config, result.profile, appVersion);

  // 挡不挡同步
  upgrade.checkMinVersion(result.config?.min_client_version);
  if (result.outboxReport.paused) upgrade.reportUpgradeRequired(result.outboxReport.paused.min, 'queue');
  upgrade.afterReloadCheck();

}

/**
 * 联网后（启动、切到前台）整行刷新了 app_config、profiles 本人那一行：写进 meta、重算功能开关、重新比最低版本。
 * 由 K8 / 登录流程调用；返回新的开关集合（null 同 enabledFlags）
 */
export async function applyFreshConfig(
  boot: BootResult,
  fresh: { config?: CachedConfig; profile?: CachedProfile },
  appVersion: string = buildInfo.version,
): Promise<ReadonlySet<string> | null> {
  if (fresh.config) {
    boot.config = fresh.config;
    if (boot.cache && !boot.cache.isClosed()) await boot.cache.setMeta('config', fresh.config);
  }
  if (fresh.profile) {
    boot.profile = fresh.profile;
    if (boot.cache && !boot.cache.isClosed()) await boot.cache.setMeta('profile', fresh.profile);
  }
  boot.flags = enabledFlags(boot.config, boot.profile, appVersion);
  boot.upgrade.checkMinVersion(boot.config?.min_client_version);
  return boot.flags;
}
