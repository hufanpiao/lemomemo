// 换账号就清空本机（架构 4.1、0.38 第 17 条；K6 审查 M1～M4、L3 返工）
// • “库归谁”记在 owner 仓（rebuildable = false，迁移失败也不丢；不放 meta：meta 会被重建，见 cache-schema.ts）
// • 比对和清空在同一个覆盖全部仓的 readwrite 事务里（claimCache）：事务里读 owner，仍然不同才清空，并在同一个事务里写入新 user_id；
//   清空含 outbox、drafts、vault_drafts、pending_actions：旧账号还没发的改动直接丢，不发。owner 没有记录（第一次建库）也照样清空再写，
//   库里不会留下归属不明的内容
// • 清完以后再清 Cache Storage 的运行时缓存（platform/session.ts 的 clearCacheStorage，SW 预缓存保留，0.38 第 36 条）
// • 判断时机（四个）：启动时（boot.ts 的 coldStart）、本页登录（SIGNED_IN）、刷新令牌（TOKEN_REFRESHED）、别的标签页的 storage 事件（watchAccount）；
//   watchAccount 挂上以后马上再读一次会话比一次，补上“启动读会话”到“挂上监听”之间漏掉的事件（M1）
// • 闸（M2）：发现会话里的账号和本页启动时的账号不同，同步地设 boot.switching = true、outbox.suspend()（enqueue 拒收、next 返回 null、
//   applyServer 等一律不做），再清库、关库、onSwitched()（默认重新载入）。K8 每发一项前、每处理一个响应前先看这道闸
// • 失败即关（M3）：清库失败也关库，再 onFailed()（默认同 onSwitched：重新载入，冷启动会再清一次；再失败就按“本机库不可用”启动，不渲染缓存）
// 纯 TS：不准 import React 和任何功能（A1）
import type { BootResult } from './boot.ts';
import type { Cache } from './cache.ts';
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
}

/** 比对并在需要时清空（库、内存集合、Cache Storage 的运行时缓存）；返回是否换了账号。出错就抛（调用方按“失败即关”处理） */
export async function ensureAccount(cache: Cache, userId: string, deps: EnsureAccountDeps): Promise<boolean> {
  const r = await claimCache(cache, userId);
  if (r === 'same') return false;
  clearAllCollections();
  if (r === 'first') return false;
  await deps.clearCacheStorage();
  return true;
}

export interface WatchAccountDeps extends EnsureAccountDeps {
  /** 本页的 SIGNED_IN、TOKEN_REFRESHED（platform/session.ts 的 onAuthUser） */
  onAuthUser(fn: (userId: string) => void): () => void;
  /** 别的标签页改了会话（platform/session.ts 的 onSessionStorageChange）；null 表示那边退出了 */
  onStorageUser(fn: (userId: string | null) => void): () => void;
  /** 现在会话里的 user_id（platform/session.ts 的 readSessionUserId）：挂上监听后马上再比一次（M1） */
  currentUserId(): string | null;
  /** 会话没了（别的标签页退出）：去登录页；本机库由退出流程清 */
  onSignedOut(): void;
  /** 换了账号、已清空并关库：默认重新载入，让冷启动、功能开关、同步都按新账号从头来 */
  onSwitched(): void;
  /** 清库失败（已关库）：不填同 onSwitched（重新载入，冷启动会再清一次） */
  onFailed?(): void;
}

/**
 * 同步设闸（换账号、被移除、本页退出登录共用）：boot.switching = true、outbox.suspend()、cache.seal()。
 * 之后 outbox 一律拒绝（enqueue 拒收、next 为空、ack / fail 不写库），库封存（除了清空，新的写事务都抛 CacheClosedError），
 * K8 不再发送、不再写回。不能解除：调用方接着 cache.clearAll()（封存后照样能清）、关库、离开页面。
 * K9 设置页的退出流程：sealForExit(boot) → await boot.cache?.clearAll() → 清运行时缓存、删会话 → 去登录页
 */
export function sealForExit(boot: BootResult): void {
  boot.switching = true;
  boot.outbox?.suspend();
  boot.cache?.seal();
}

const closeGate = sealForExit;

function closeCache(boot: BootResult): void {
  try {
    boot.cache?.close();
  } catch {
    // 已经关了
  }
}

/**
 * 盯住后三个时机（启动那一次在 coldStart 里），挂上后马上再比一次。
 * 一旦发现账号变了（或会话没了），只处理这一次：设闸 → 清库 → 关库 → onSwitched / onFailed（会话没了：设闸 → onSignedOut）。
 * 返回取消函数
 */
export function watchAccount(boot: BootResult, deps: WatchAccountDeps): () => void {
  let handled = false;
  const check = (userId: string | null): void => {
    if (handled || userId === boot.userId) return;   // 同一个账号（刷新令牌）：什么也不做
    handled = true;
    closeGate(boot);   // 同步设闸：从这一刻起不再发送、不再写回
    if (userId === null) {
      deps.onSignedOut();
      return;
    }
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
  const offAuth = deps.onAuthUser((id) => check(id));
  const offStorage = deps.onStorageUser((id) => check(id));
  check(deps.currentUserId());
  return () => {
    offAuth();
    offStorage();
  };
}

export interface RemovedDeps {
  /** platform/session.ts 的 clearCacheStorage（只删运行时缓存） */
  clearCacheStorage(): Promise<void>;
  /** 清完以后：删本机会话（clearLocalSession，signOut 这时多半走不通）、回登录页显示“已被移除”的提示 */
  onRemoved(): void;
}

/**
 * 被移除或被停用（outbox 的 removed 事件：session_revoked、account_disabled；TC-B1-77 ⑤）：
 * 设闸 → 清空整个本机库（含 outbox，还没上传的改动丢弃）和运行时缓存 → 关库 → onRemoved。清库失败也照样关库、onRemoved（失败即关）
 */
export async function wipeOnRemoved(boot: BootResult, deps: RemovedDeps): Promise<void> {
  closeGate(boot);
  try {
    if (boot.cache && !boot.cache.isClosed()) await boot.cache.clearAll();
    clearAllCollections();
    await deps.clearCacheStorage();
  } catch {
    clearAllCollections();
  } finally {
    closeCache(boot);
    deps.onRemoved();
  }
}
