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
// • 会话没了（别的标签页退出）：设闸 → 清空整库 → 关本页连接 → 按库名删库 → 清运行时缓存 → onSignedOut（登录页审查：不留上一个账号的数据）
// • 本页的 SIGNED_OUT（刷新失败、被移除、被退出，K6-signedout）：和 SIGNED_IN、TOKEN_REFRESHED 同一个监听（deps.onAuthUser 的第二个回调），
//   自己点“退出登录”的那一次已由 platform 按标记滤掉；已经在走别的退出流程（boot.switching）也不管。
//   其余按“被移除或被退出”：不删 devices（旧会话已失效）→ 设闸 → 清空整库 → 关库 → 按库名删库 → 清运行时缓存
//   （SW 预缓存、install_id 不动）→ onSignedOut('removed', 删掉的 session_id)，登录页提示“这台设备已在别的设备上被移除……”。
//   会话里已经是别的账号（别的标签页刚登录）就按换账号处理。
//   本机会话在判断“会话里现在是谁”的同一个同步段里就删（deps.dropSession，K6-signedout-sugg2 ①），删掉的 session_id 交给 onSignedOut：
//   清库要几秒，等清完再删会把这几秒里别的标签页刚登录的新会话也删掉
// • 失败即关（M3）：清库失败也关库，再 onFailed()（默认同 onSwitched：重新载入，冷启动会再清一次；再失败就按“本机库不可用”启动，不渲染缓存）
// • 浏览器推送（B2 安全审查 FE-2）：换账号、会话没了、被移除时，清库之后、删库之前先关掉本 App 已显示的通知、退订推送
//   （platform/push-disconnect.ts 的 disconnectPushLazy：先删认领记录，再按需下载 push.ts 断开，自带上限、下载失败也不挡，11-05）；设置页自己退出的那条在 platform/sign-out.ts 的 wipeThisDevice 里
// • R-382（架构 4.1a 第 1、2 点）：本页的 SIGNED_OUT、别的标签页删了会话（storage 事件）都先分类，不再一律清库：
//   - signedOutHere：同步删会话、设闸、先写 lemo.reauth（别的标签页的 storage 事件读得到），再 resolveAuthLoss（码取 refresh-observer 的记录，
//     没有按 'none'）。expired → 只关库、不清，onSignedOut('expired', sid)；removed → 删记号、清库，onSignedOut('removed', sid)
//   - storage 那一路（会话变 null）：设闸，等 reauthGraceMs（supabase-js 先删键再通知，那一页写记号要晚几毫秒）再读 lemo.reauth：
//     是本账号的 → 只关库、onSignedOut('expired', 记号里的 sid)；否则照旧清库、删记号
//   - 写不了记号（存储不可用）：退回原来的清库，记 auth_loss_store_failed
//   - 清本机数据只走 wipeLocal（同一步删 lemo.reauth；删不掉记 auth_loss_store_failed）。lemo.authloss 被动清库不删
// 纯 TS：不准 import React 和任何功能（A1）
import type { BootResult } from './boot.ts';
import type { AuthLossSignal } from './auth-loss.ts';
import { resolveAuthLossLazy } from './auth-loss-lazy.ts';
import { clearReauth, readReauth, writeReauth, type ReauthReason } from '../platform/auth-loss-store.ts';
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

export interface WatchAccountDeps extends EnsureAccountDeps {
  /**
   * 本页的 SIGNED_IN、TOKEN_REFRESHED（platform/session.ts 的 onAuthUser）；同一个监听的 SIGNED_OUT 回调 onSignedOut
   * （自己退出的已滤掉，K6-signedout）。K8、各功能页不另开 SIGNED_OUT 监听
   */
  onAuthUser(fn: (userId: string) => void, onSignedOut?: (deadSessionId?: string | null, failure?: RefreshFailure | null) => void): () => void;
  /** 别的标签页改了会话（platform/session.ts 的 onSessionStorageChange）；null 表示那边退出了 */
  onStorageUser(fn: (userId: string | null) => void): () => void;
  /** 现在会话里的 user_id（platform/session.ts 的 readSessionUserId）：挂上监听后马上再比一次（M1） */
  currentUserId(): string | null;
  /**
   * 会话没了，本页已经清掉本机库以后调，去登录页：别的标签页退出时不带参数；
   * 本页收到 SIGNED_OUT（被移除或被退出）时带 'removed'，登录页提示“已在别的设备上被移除”（platform/session.ts 的 goToAuth）
   */
  onSignedOut(...args: [] | [reason: 'removed' | 'expired', deadSessionId: string | null]): void;
  /**
   * 本页收到 SIGNED_OUT（被移除或被退出）时同步删掉本机会话，返回删之前的 session_id（platform/session.ts 的 takeLocalSession；
   * K6-signedout-sugg2 ①）。和判断“会话里现在是谁”在同一个同步段里调，返回值原样交给 onSignedOut('removed', …)，
   * 那边只在会话还是这一个时才再删一次。必填（K6-sugg4 ②：带 'removed' 时一定带着 session_id，不再有“不给就直接删”）
   */
  dropSession(): string | null;
  /** 被移除或被退出时停掉并清掉这个账号的日志上传队列（架构 0.38 第 68 条）；不填不清 */
  clearLogs?(): void;
  /**
   * 会话没了时按库名删掉整个本机库（core/cache.ts 的 deleteCacheDb）；在本页连接关掉以后调，不会触发本页的 versionchange。
   * 不填只清空内容、关库（库文件留着，里面没有数据）
   */
  deleteDb?(): Promise<unknown>;
  /** 换了账号、已清空并关库：默认重新载入，让冷启动、功能开关、同步都按新账号从头来 */
  onSwitched(): void;
  /** 清库失败（已关库）：不填同 onSwitched（重新载入，冷启动会再清一次） */
  onFailed?(): void;
  /** 会话没了怎么定结局（R-382；默认 core/auth-loss.ts 的 resolveAuthLoss）；测试换掉 */
  resolve?(signal: AuthLossSignal): Promise<'expired' | 'removed'>;
  /**
   * 别的标签页删了会话（storage 事件）以后等多久再读 lemo.reauth（R-382；main.tsx 传 REAUTH_GRACE_MS）。
   * 不填（0）不等：同步读
   */
  reauthGraceMs?: number;
  /** 记一条日志（只有 act，例如 auth_loss_store_failed）；不填不记 */
  log?(act: string): void;
}

/** 别的标签页 SIGNED_OUT 写记号要晚几毫秒：storage 事件一来先等这么久再读（R-382） */
export const REAUTH_GRACE_MS = 1000;

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
  // 推送认领的上下文一起作废（FA6-r3-low N4 / L9）：之后设置 › 提醒 的点按认领、等着上下文的认领都回 claim_failed，清掉上一账号的认领结果
  setPushClaimContext(null);
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

/** 只关库、不清（记号已由别处写好）：别的标签页 expired 了、本页跟着回登录页 */
function closeOnly(boot: BootResult): void {
  closeCache(boot);
}

/**
 * 盯住后三个时机（启动那一次在 coldStart 里），挂上后马上再比一次。
 * 一旦发现账号变了（或会话没了），只处理这一次：设闸 → 清库 → 关库 → onSwitched / onFailed（会话没了：设闸 → 清库 → 关库 → 删库 → onSignedOut）。
 * 本页的 SIGNED_OUT（不是自己退出）也在这里接，和上面共用“只处理一次”（K6-signedout）。
 * 返回取消函数
 */
export function watchAccount(boot: BootResult, deps: WatchAccountDeps): () => void {
  let handled = false;
  const check = (userId: string | null): void => {
    if (handled || userId === boot.userId) return;   // 同一个账号（刷新令牌）：什么也不做
    handled = true;
    if (userId === null) boot.sessionGone = true;   // 会话没了（别的标签页退出），见 BootResult.sessionGone
    closeGate(boot);   // 同步设闸：从这一刻起不再发送、不再写回
    if (userId === null) {
      // 别的标签页退出了（登录页审查）：本页可能已按这个账号开库、同步过，不能把数据留在硬盘上。
      // 例外（R-382）：那边是登录过期（lemo.reauth 是本账号的），本页同样只关库、回登录页
      const decide = (): void => {
        const r = readReauth();
        if (r && r.user_id === boot.userId) {
          closeOnly(boot);
          deps.onSignedOut('expired', r.session_id);
          return;
        }
        void wipeLocal(boot, { ...deps, dropDb: Boolean(deps.deleteDb) }).finally(() => deps.onSignedOut());
      };
      const grace = deps.reauthGraceMs ?? 0;
      if (grace > 0) setTimeout(decide, grace);
      else decide();
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
    // auth-js 先删键再通知 SIGNED_OUT：这时本机多半已没有会话、删不出 session_id，用会话层带来的“本页最后见到的那个”
    // （K6-signout-lib），回登录页前按它再删一次（晚到的刷新把它写回时）
    dead ??= lastSessionId;
    handled = true;
    // 先写记号再定结局（R-382）：supabase-js 已经删了会话键，别的标签页的 storage 事件随时会到，它们等 reauthGraceMs 后读记号；
    // 查 session_fate 要几秒，判成 removed 再删记号、清库（别的标签页已经只关了库的，登录页再查时补清）
    const kept = markExpired(boot, dead);
    if (!kept) deps.log?.('auth_loss_store_failed');
    const removed = (): void => {
      try {
        deps.clearLogs?.();
      } catch {
        // 日志队列清不掉不挡退出
      }
      void wipeLocal(boot, { ...deps, dropDb: Boolean(deps.deleteDb) }).finally(() => deps.onSignedOut('removed', dead));
    };
    if (!kept) return removed();   // 写不了记号：退回原来的清库（4.1a 第 7 点）
    const signal: AuthLossSignal = {
      path: 'sdk', code: failure?.code ?? 'none', status: failure?.status ?? 0,
      sessionId: failure?.sid ?? dead, userId: boot.userId,
    };
    void (deps.resolve ?? resolveAuthLossLazy)(signal)
      .catch(() => 'expired' as const)
      .then((r) => {
        if (r === 'removed') return removed();
        closeOnly(boot);
        deps.onSignedOut('expired', dead);
      });
  };
  const offAuth = deps.onAuthUser((id) => check(id), signedOutHere);
  const offStorage = deps.onStorageUser((id) => check(id));
  check(deps.currentUserId());
  return () => {
    offAuth();
    offStorage();
  };
}

export interface WipeDeps extends Pick<WatchAccountDeps, 'clearCacheStorage' | 'disconnectPush' | 'log'> {
  /** 按库名删库（默认 core/cache.ts 的 deleteCacheDb，库名取本页的库） */
  deleteDb?(): Promise<unknown>;
  /** true：清完也按库名删整个库（会话没了，不留库文件）；默认只在清库卡住或失败时删 */
  dropDb?: boolean;
  /** 测试用：清库（含按库名删）、清运行时缓存各自的上限 */
  wipeMs?: number;
  cachesMs?: number;
}

/** 清库、清运行时缓存各自最多等多久（和 platform/sign-out.ts 的 WIPE_TIMEOUT_MS、CACHES_TIMEOUT_MS 同值） */
export const WIPE_MS = 3000;
export const WIPE_CACHES_MS = 2000;

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
 * 清本机数据只在这里做（架构约定 10.1）：设闸 → 删 lemo.reauth → 清空整库（含 outbox，没上传的丢弃）→ 清内存集合 → 断开推送 → 关库
 * →（清不掉或 dropDb）按库名删库 → 清运行时缓存。每一步有上限、失败照样往下走，永远 resolve；最坏约 WIPE_MS × 2 + WIPE_CACHES_MS
 */
export async function wipeLocal(boot: BootResult, deps: WipeDeps): Promise<void> {
  closeGate(boot);
  // 删不掉时下次冷启动登录页会再查 session_fate
  if (!clearReauth()) deps.log?.('auth_loss_store_failed');
  const wipeMs = deps.wipeMs ?? WIPE_MS;
  const cache = boot.cache;
  try {
    // 超时后 clearAll 不取消，关库后它以“库已关”结束，没人等它；本机库靠按库名删清掉
    const cleared = !cache || cache.isClosed() || (await capped(() => cache.clearAll(), wipeMs));
    clearAllCollections();
    await disconnectPush(deps);
    closeCache(boot);   // 原因 'closed'：不触发 versionchange → 重新载入
    if (!cleared || deps.dropDb) await capped(deps.deleteDb ?? (() => deleteCacheDb({ name: cache?.name, waitMs: wipeMs })), wipeMs);
    await capped(() => deps.clearCacheStorage(), deps.cachesMs ?? WIPE_CACHES_MS);
  } catch {
    clearAllCollections();
  } finally {
    closeCache(boot);
  }
}
