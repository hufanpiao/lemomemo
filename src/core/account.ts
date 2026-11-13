// 本机库归谁、换账号就清空（claimCache、ensureAccount、watchAccount 换账号那一半），以及退出用的几块：设闸、写记号只关库、清本机数据
// 不变量：比对 owner 和清空在同一个覆盖全部仓的事务里；换账号先同步设闸再清；会话没了只设闸、交给 onSessionLost（core/device-exit.ts）
// 不变量：清本机数据只在 wipeLocal / clearLocalData 做；纯 TS，不准 import React 和任何功能（A1）。详细说明见架构 4.1、4.1a
import type { BootResult } from './boot.ts';
import { clearReauth, writeReauth, type ReauthReason } from '../platform/auth-loss-store.ts';
import { CACHES_TIMEOUT_MS, forgetLook, WIPE_TIMEOUT_MS } from '../platform/exit-basics.ts';
import type { RefreshFailure } from '../platform/supabase/refresh-failure.ts';
import { disconnectPushLazy } from '../platform/push-disconnect.ts';
import { setPushClaimContext } from '../platform/push-claim-run.ts';
import { deleteCacheDb, type Cache } from './cache.ts';
import { OWNER } from './cache-schema.ts';
import { clearAllCollections } from './store.ts';

const OWNER_KEY = 'user_id';

/** claimCache 的结果：same 本来就是这个账号；first 第一次记下（库是新的）；switched 换了账号，已清空 */
export type ClaimResult = 'same' | 'first' | 'switched';

/**
 * 一个覆盖库里实际存在的全部仓（含 stores 以外的旧仓，K6 复审 N5）的 readwrite 事务：读 owner，不同就清空所有仓并写入新 user_id。
 * 封存以后照样能开（bypassSeal）。出错时整个事务回滚、抛出
 */
export function claimCache(cache: Cache, userId: string): Promise<ClaimResult> {
  const names = cache.storeNames();
  return cache.tx(
    names,
    'readwrite',
    async (t) => {
      const rec = await t.get<{ key: string; value: string }>(OWNER, OWNER_KEY);
      const owner = rec?.value;
      if (owner === userId) return 'same';
      for (const n of names) await t.clear(n);
      await t.put(OWNER, { key: OWNER_KEY, value: userId });
      return owner === undefined ? 'first' : 'switched';
    },
    { bypassSeal: true },
  );
}

/** 本机库现在归谁；没有记录为 undefined */
export async function cacheOwner(cache: Cache): Promise<string | undefined> {
  const rec = await cache.tx([OWNER], 'readonly', (t) => t.get<{ key: string; value: string }>(OWNER, OWNER_KEY));
  return rec?.value;
}

export interface EnsureAccountDeps {
  /** platform/session.ts 的 clearCacheStorage（只删运行时缓存） */
  clearCacheStorage(): Promise<void>;
  /**
   * 断开浏览器推送：关掉本 App 已显示的通知、退订推送（B2 安全审查 FE-2；默认 platform/push-disconnect.ts 的 disconnectPushLazy，按需下载 push.ts 的 disconnectBrowserPush，
   * 自带上限、不抛）。换账号、会话没了、被移除时在清库之后、删库之前调，旧账号的标题不留在通知中心、旧账号的推送不再到达
   */
  disconnectPush?(): Promise<void>;
}

/** 断开浏览器推送：出错、超时都不挡后面的步骤 */
async function disconnectPush(deps: Pick<EnsureAccountDeps, 'disconnectPush'>): Promise<void> {
  try {
    await (deps.disconnectPush ?? (() => disconnectPushLazy()))();
  } catch {
    // 断不开不挡退出、换账号
  }
}

/** 比对并在需要时清空（库、内存集合、Cache Storage 的运行时缓存）；返回是否换了账号。出错就抛（调用方按“失败即关”处理） */
export async function ensureAccount(cache: Cache, userId: string, deps: EnsureAccountDeps): Promise<boolean> {
  const r = await claimCache(cache, userId);
  if (r === 'same') return false;
  clearAllCollections();
  if (r === 'first') return false;
  await disconnectPush(deps);
  await deps.clearCacheStorage();
  return true;
}

/** 会话没了：here = 本页的 SIGNED_OUT（sid：已删掉的本机会话；failure：最近 120 秒内刷新令牌失败的记录）；否则是别的标签页删了会话 */
export type SessionLoss = { here: true; sid: string | null; failure: RefreshFailure | null } | { here: false };

export interface WatchAccountDeps extends EnsureAccountDeps {
  /**
   * 本页的 SIGNED_IN、TOKEN_REFRESHED（platform/session.ts 的 onAuthUser）；同一个监听的 SIGNED_OUT 回调
   * （自己退出的已滤掉，K6-signedout）。K8、各功能页不另开 SIGNED_OUT 监听
   */
  onAuthUser(fn: (userId: string) => void, onSignedOut?: (deadSessionId?: string | null, failure?: RefreshFailure | null) => void): () => void;
  /** 别的标签页改了会话（platform/session.ts 的 onSessionStorageChange）；null 表示那边退出了 */
  onStorageUser(fn: (userId: string | null) => void): () => void;
  /** 现在会话里的 user_id（platform/session.ts 的 readSessionUserId）：挂上监听后马上再比一次（M1） */
  currentUserId(): string | null;
  /**
   * 本页收到 SIGNED_OUT 时同步删掉本机会话，返回删之前的 session_id（platform/session.ts 的 takeLocalSession；K6-signedout-sugg2 ①）。
   * 和判断“会话里现在是谁”在同一个同步段里调，返回值交给 onSessionLost，回登录页前只在会话还是这一个时再删
   */
  dropSession(): string | null;
  /** 会话没了（闸已设好）：怎么退出交给 core/device-exit.ts 的 exitOnSessionLoss（main.tsx 接上）；watchAccount 自己不清库、不跳转 */
  onSessionLost(loss: SessionLoss): void;
  /** 换了账号、已清空并关库：默认重新载入，让冷启动、功能开关、同步都按新账号从头来 */
  onSwitched(): void;
  /** 清库失败（已关库）：不填同 onSwitched（重新载入，冷启动会再清一次） */
  onFailed?(): void;
}

/**
 * 同步设闸（换账号、被移除、本页退出登录共用）：boot.switching = true、outbox.suspend()、cache.seal()。
 * 之后 outbox 一律拒绝（enqueue 拒收、next 为空、ack / fail 不写库），库封存（除了清空，新的写事务都抛 CacheClosedError），
 * K8 不再发送、不再写回。不能解除：调用方接着清库（封存后照样能清）或关库、离开页面
 */
export function sealForExit(boot: BootResult): void {
  boot.switching = true;
  boot.outbox?.suspend();
  boot.cache?.seal();
  // 推送认领的上下文一起作废（FA6-r3-low N4 / L9）：之后设置 › 提醒 的点按认领、等着上下文的认领都回 claim_failed，清掉上一账号的认领结果
  setPushClaimContext(null);
}

const closeGate = sealForExit;

/** 关本页的库连接（原因 'closed'，不触发 versionchange → 重新载入）；已经关了不管 */
export function closeCache(boot: BootResult): void {
  try {
    boot.cache?.close();
  } catch {
    // 已经关了
  }
}

/**
 * 登录过期（R-382 架构 4.1a 第 2 点）：设闸（停同步、停 Realtime、停上传）→ 写 lemo.reauth → 关本页连接。
 * outbox、server、view 三份全部留着，Cache Storage 也不清。写不了记号返回 false（只设了闸，调用方退回清库）。
 * 不删会话、不跳转：调用方随后 clearLocalSessionIf(sid)、回登录页（记号要先于删会话写好，别的标签页的 storage 事件才读得到）。
 * reason：记号里记下的原因（已停用传 'disabled'，登录页据此提示，R-382 复核建议 ①）
 */
export function expireThisTab(boot: BootResult, sessionId: string | null, reason: ReauthReason = 'expired', now: number = Date.now()): boolean {
  if (!markExpired(boot, sessionId, reason, now)) return false;
  // 内存集合不清：界面照旧，不闪成空白；随后整页离开
  closeCache(boot);
  return true;
}

/**
 * 结局还没定（要查 session_fate）时先做的一半：设闸、写 lemo.reauth，不关库。
 * 不关库是因为判成 removed 时还要清库（wipeLocal 见库已关会当成“没有要清的”）。写不了记号返回 false
 */
export function markExpired(boot: BootResult, sessionId: string | null, reason: ReauthReason = 'expired', now: number = Date.now()): boolean {
  boot.sessionGone = true;
  closeGate(boot);
  return boot.userId !== null && writeReauth(boot.userId, sessionId, now, undefined, reason);
}

/**
 * 盯住后三个时机（启动那一次在 coldStart 里），挂上后马上再比一次。只处理一次（handled）：
 * 换了账号 → 设闸 → 清库 → 关库 → onSwitched / onFailed；会话没了（别的标签页退出、本页 SIGNED_OUT）→ 设闸 → onSessionLost。
 * 返回取消函数
 */
export function watchAccount(boot: BootResult, deps: WatchAccountDeps): () => void {
  let handled = false;
  const check = (userId: string | null): void => {
    if (handled || userId === boot.userId) return;   // 同一个账号（刷新令牌）：什么也不做
    handled = true;
    if (userId === null) boot.sessionGone = true;   // 会话没了（别的标签页退出），见 BootResult.sessionGone
    closeGate(boot);   // 同步设闸：从这一刻起不再发送、不再写回
    if (userId === null) return deps.onSessionLost({ here: false });
    const run = async (): Promise<void> => {
      const cache = boot.cache;
      // 本机库打不开（unavailable、version_too_new）或已关：没有要清的库，照样按新账号重来（L3）
      let clearCaches = true;
      if (cache && !cache.isClosed()) {
        // 清完立刻关库，不等 Cache Storage（N2）；别的标签页已经清过（owner 已是新账号）就不再清 Cache Storage
        const r = await claimCache(cache, userId);
        closeCache(boot);
        clearAllCollections();
        clearCaches = r === 'switched';
        if (r === 'switched') await disconnectPush(deps);
      }
      if (clearCaches) await deps.clearCacheStorage();
      boot.switchedUser = true;
      boot.fullResync = cache ? [...cache.syncTables] : [];
      boot.config = null;
      boot.profile = null;
      boot.flags = null;
    };
    void run().then(
      () => {
        closeCache(boot);
        deps.onSwitched();
      },
      () => {
        closeCache(boot);
        clearAllCollections();
        (deps.onFailed ?? deps.onSwitched)();
      },
    );
  };
  /** 本页的 SIGNED_OUT（不是自己退出，K6-signedout）；failure：最近 120 秒内刷新令牌失败的记录（R-382） */
  const signedOutHere = (lastSessionId: string | null = null, failure: RefreshFailure | null = null): void => {
    if (handled || boot.switching) return;   // 已经在走换账号、被移除、自己退出等流程
    const now = deps.currentUserId();
    if (now !== null && now !== boot.userId) {
      check(now);   // 别的标签页刚登录了别的账号：按换账号处理
      return;
    }
    // 同一个同步段里删本机会话（这时会话里要么没人、要么还是本账号那个已作废的会话）
    let dead: string | null;
    try {
      dead = deps.dropSession();
    } catch {
      dead = null;   // 删不掉（存储不可用）：本来也存不下会话
    }
    // auth-js 先删键再通知 SIGNED_OUT：这时多半删不出 session_id，用会话层带来的“本页最后见到的那个”（K6-signout-lib）
    dead ??= lastSessionId;
    handled = true;
    deps.onSessionLost({ here: true, sid: dead, failure });
  };
  const offAuth = deps.onAuthUser((id) => check(id), signedOutHere);
  const offStorage = deps.onStorageUser((id) => check(id));
  check(deps.currentUserId());
  return () => {
    offAuth();
    offStorage();
  };
}

export interface WipeDeps extends Pick<EnsureAccountDeps, 'clearCacheStorage' | 'disconnectPush'> {
  /** 按库名删库（默认 core/cache.ts 的 deleteCacheDb，库名取本页的库） */
  deleteDb?(): Promise<unknown>;
  /** true：清完也按库名删整个库（会话没了，不留库文件）；默认只在清库卡住或失败时删 */
  dropDb?: boolean;
  /** 记一条日志（只有 act，例如 auth_loss_store_failed）；不填不记 */
  log?(act: string): void;
  /** 测试用：清库（含按库名删）、清运行时缓存各自的上限（默认 platform/exit-basics.ts 的 WIPE_TIMEOUT_MS、CACHES_TIMEOUT_MS） */
  wipeMs?: number;
  cachesMs?: number;
}

/** 到点或出错都返回 false，按时完成返回 true；原来的操作不取消 */
function capped(run: () => Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    Promise.resolve()
      .then(run)
      .then(
        () => (clearTimeout(t), resolve(true)),
        () => (clearTimeout(t), resolve(false)),
      );
  });
}

/**
 * 清空整库（含 outbox，没上传的丢弃）和内存集合：不设上限、失败就抛。
 * 设置页本人退出只调这一步（上限、推送、缓存、按库名删由 platform/sign-out.ts 的 wipeThisDevice 做）；其余出口走 wipeLocal
 */
export async function clearLocalData(cache: Cache): Promise<void> {
  forgetLook();
  await cache.clearAll();
  clearAllCollections();
}

/**
 * 清本机数据（架构约定 10.1）：设闸 → 删 lemo.reauth → clearLocalData → 断开推送 → 关库
 * →（清不掉或 dropDb）按库名删库 → 清运行时缓存。每一步有上限、失败照样往下走，永远 resolve；最坏约 WIPE_TIMEOUT_MS × 2 + CACHES_TIMEOUT_MS
 */
export async function wipeLocal(boot: BootResult, deps: WipeDeps): Promise<void> {
  closeGate(boot);
  forgetLook();
  // 删不掉时下次冷启动登录页会再查 session_fate
  if (!clearReauth()) deps.log?.('auth_loss_store_failed');
  const wipeMs = deps.wipeMs ?? WIPE_TIMEOUT_MS;
  const cache = boot.cache;
  try {
    // 超时后清库不取消，关库后它以“库已关”结束，没人等它；本机库靠按库名删清掉
    const cleared = !cache || cache.isClosed() || (await capped(() => clearLocalData(cache), wipeMs));
    clearAllCollections();
    await disconnectPush(deps);
    closeCache(boot);   // 原因 'closed'：不触发 versionchange → 重新载入
    if (!cleared || deps.dropDb) await capped(deps.deleteDb ?? (() => deleteCacheDb({ name: cache?.name, waitMs: wipeMs })), wipeMs);
    await capped(() => deps.clearCacheStorage(), deps.cachesMs ?? CACHES_TIMEOUT_MS);
  } catch {
    clearAllCollections();
  } finally {
    closeCache(boot);
  }
}
