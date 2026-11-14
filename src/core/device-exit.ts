// 账号没了、会话没了怎么退出这台设备（架构约定 10.1）：decideExit 定结局，exitDevice 执行；主 App、告知页、插图上传、会话层都走这里
// （设置页 useSessionExit 和本人退出走 platform/sign-out.ts 的清库步骤，不经这里）。清库走 account.ts 的 wipeLocal；
// 日志上传队列、外观、隐私记同意在 wipeLocal 里清（platform/exit-basics.ts 的 forgetAccountLocal），没启动（没有 boot）时这里直接调它
// 不变量：被移除必须服务器确认（session_fate 回 revoked）才清库，查不了、查出错都只退出；停用、过期只退出；冷静期不删会话
// 不变量：记号写好以后只关库、不再写第二次；写不了记号才退回清库：登录过期、未确认的被移除退回清库时提示 removed，停用仍提示 disabled
// 不变量：同一页只执行一次（exited）。顺序：被移除先设闸、写记号、删会话、查服务器 → 只关库或清库 → 广播带原因的 reset → 删会话 → 回登录页
// 不变量：交接救回（换上了新会话）不退出，但发现被移除的那一路已停下（outbox 设闸、引擎 halt、sync-wiring 只处理一次），都不会自己恢复：
// 先解开 outbox 的闸（pagehide 时补存的草稿还能写进本机），再整页重新载入，用新会话从头启动
import { closeCache, expireThisTab, markExpired, wipeLocal, type SessionLoss } from './account.ts';
import type { AuthLossOutcome, AuthLossPath, AuthLossSignal } from './auth-loss.ts';
import { resolveAuthLossLazy } from './auth-loss-lazy.ts';
import { getBoot, type BootResult } from './boot.ts';
import { rescueByRebind } from './rebind-pending.ts';
import { readReauth } from '../platform/auth-loss-store.ts';
import { forgetAccountLocal } from '../platform/exit-basics.ts';
import { rlog } from '../platform/run-log-api.ts';
import { clearCacheStorage, clearLocalSessionIf, goToAuth, type ExitNotice } from '../platform/session.ts';
import { reloadPage } from '../platform/sw-register.ts';

/** 为什么退出：服务器码映射出的原因、探测结果；active = 账号正常；followed = 别的标签页已退出，跟着清库（不删会话、不记原因、不广播） */
export type ExitReason = ExitNotice | 'active' | 'followed';

export interface ExitFacts {
  reason: ExitReason;
  /** reason 为 removed 时服务器 session_fate 的结局；没查、查不出都不算确认 */
  fate?: AuthLossOutcome;
  /** 注销申请成功：服务器已在同一事务里吊销全部会话，冷静期也删会话 */
  revoked?: boolean;
}

export type ExitPlan =
  | { act: 'stay' }
  | { act: 'logout' | 'logout_wipe'; notice: ExitNotice | null; dropSession: boolean; broadcast: boolean };

/** 定结局：只退出（logout）/ 退出并清库（logout_wipe）/ 不动（stay） */
export function decideExit(f: ExitFacts): ExitPlan {
  if (f.reason === 'active') return { act: 'stay' };
  if (f.reason === 'followed') return { act: 'logout_wipe', notice: null, dropSession: false, broadcast: false };
  if (f.reason === 'removed' && f.fate !== 'removed') return { act: 'logout', notice: 'expired', dropSession: true, broadcast: true };
  const keep = f.reason === 'expired' || f.reason === 'disabled';
  return { act: keep ? 'logout' : 'logout_wipe', notice: f.reason, dropSession: f.reason !== 'pending_deletion' || f.revoked === true, broadcast: true };
}

export interface ExitDeps {
  getBoot(): BootResult | null;
  /** 清本机库（默认 wipeLocal，带运行时缓存） */
  wipe(boot: BootResult): Promise<void>;
  /** 只退出：设闸、写 lemo.reauth、关库（默认 expireThisTab；停用记 null sid）；false = 写不了记号，退回清库 */
  keep(boot: BootResult, notice: ExitNotice, sid: string | null): boolean;
  /** 本机会话还是这个 session_id 才删 */
  clearLocalSessionIf(sid: string | null): Promise<boolean>;
  /** 停掉日志上传器（app/log-channel.ts 的 logQueueCleaner：之后不记、不传）；队列本身由清库那一步清，不给不停 */
  clearLogs?(): void;
  /** 删会话之前告诉别的标签页退出原因（reset 带 notice、sid） */
  broadcastReset(userId: string, exit: { notice: ExitNotice; sid: string | null }): void;
  /** 清完库再发一条不带原因的 reset（别的标签页整份重读）；只有原来就发的调用方（设置页、插图上传）给，不给不发 */
  broadcastWiped?(userId: string): void;
  /** 记退出原因、回登录页；notice 为 null 不记 */
  goToAuth(notice: ExitNotice | null, sid: string | null): void;
  /** 查服务器定会话丢了的结局（默认 resolveAuthLoss，查 session_fate） */
  resolveAuthLoss(signal: AuthLossSignal): Promise<AuthLossOutcome>;
  /** 记一条日志（只有 act，例如 auth_loss_store_failed）；不填不记 */
  log?(act: string): void;
  /** 交接救回以后重新载入（默认 platform/sw-register.ts 的 reloadPage；测试换掉） */
  reload?(): void;
}

/** 默认依赖；broadcastReset 由调用方给（platform/tab-leader.ts 的 postReset，或不广播的空函数），免得频道代码进首屏 */
export const defaultExitDeps: Omit<ExitDeps, 'broadcastReset'> = {
  getBoot,
  wipe: (boot) => wipeLocal(boot, { clearCacheStorage }),
  keep: (boot, notice, sid) => (notice === 'disabled' ? expireThisTab(boot, null, 'disabled') : expireThisTab(boot, sid)),
  clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
  goToAuth: (notice, sid) => {
    if (notice === null) goToAuth();
    else if (notice === 'removed' || notice === 'expired') goToAuth(notice, sid);
    else goToAuth(notice);
  },
  resolveAuthLoss: (signal) => resolveAuthLossLazy(signal),
};

/** 已经执行过退出的页面（一个 boot 一次；没启动过的页面共用 NO_BOOT） */
let exited = new WeakSet<object>();
const NO_BOOT = {};

/** 这一页已经在退出了（exitDevice 走过） */
export function exitStarted(boot: BootResult | null): boolean {
  return exited.has(boot ?? NO_BOOT);
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // 广播、删会话失败不挡退出（存储、频道不可用）
  }
}

/** 查服务器用的信号：sid 删会话用，lossSid 查 session_fate 用（不给同 sid）；status 不知道不填 */
interface RemovedSignal {
  sid: string | null;
  lossSid?: string | null | undefined;
  path: AuthLossPath;
  code: string;
  status?: number | undefined;
}

/**
 * 被移除先经服务器确认：设闸、写 lemo.reauth，同一个同步段里删被拒的那个会话，再查 session_fate。
 * 写不了记号（存储不可用）按 removed（退回清库，架构 4.1a 第 7 点）。查服务器出错（含分包加载失败）按 expired
 */
async function confirmRemoved(boot: BootResult, s: RemovedSignal, deps: ExitDeps): Promise<AuthLossOutcome> {
  const kept = markExpired(boot, s.sid);
  if (!kept) deps.log?.('auth_loss_store_failed');
  safe(() => void deps.clearLocalSessionIf(s.sid));
  if (!kept) return 'removed';
  try {
    const status = s.status === undefined ? {} : { status: s.status };
    return await deps.resolveAuthLoss({ path: s.path, code: s.code, ...status, sessionId: s.lossSid ?? s.sid, userId: boot.userId });
  } catch {
    return 'expired';
  }
}

/**
 * 按结局执行（顺序见文件头）。marked：记号已经写好（confirmRemoved 写的，或别的标签页写的），只关库、不再调 keep；
 * dropped：收到信号时已经删过一次会话（confirmRemoved）
 */
function runExit(
  boot: BootResult | null, plan: Exclude<ExitPlan, { act: 'stay' }>, sid: string | null, deps: ExitDeps, o: { marked: boolean; dropped: boolean },
): Promise<void> {
  const userId = boot?.userId ?? null;
  if (boot) boot.sessionGone = true;
  let kept = false;
  if (plan.act === 'logout' && boot !== null && plan.notice !== null) {
    if (o.marked) closeCache(boot);
    kept = o.marked || deps.keep(boot, plan.notice, sid);
  }
  // 退回清库：库清了，提示要让人知道没上传的改动丢了
  const notice = !kept && plan.notice === 'expired' ? 'removed' : plan.notice;
  rlog(`exit ${plan.act} notice=${notice ?? '-'} kept=${kept} boot=${boot !== null}`);
  if (userId && plan.broadcast && notice) safe(() => deps.broadcastReset(userId, { notice, sid }));
  const drop = (): void => (plan.dropSession ? safe(() => void deps.clearLocalSessionIf(sid)) : undefined);
  if (!o.dropped) drop();
  if (kept) {
    if (o.dropped) drop();   // 查服务器那几秒里旧会话被晚到的令牌刷新写回时再删
    deps.goToAuth(notice, sid);
    return Promise.resolve();
  }
  safe(() => deps.clearLogs?.());   // 停不掉不挡退出
  const finish = (): void => {
    if (userId && plan.broadcast && deps.broadcastWiped) safe(() => deps.broadcastWiped?.(userId));
    drop();   // 旧会话被晚到的令牌刷新写回时再删；别的标签页刚登录的新会话不动
    deps.goToAuth(notice, sid);
  };
  if (!boot) {
    forgetAccountLocal(null);   // 没有库要清：不知道是谁，日志队列全清
    finish();
    return Promise.resolve();
  }
  return deps.wipe(boot).then(finish, finish);
}

/**
 * 退出这台设备的入口：reason 为 removed 时先经服务器确认（confirmRemoved），再 decideExit、runExit。
 * path、code、status、lossSid：信号从哪来、服务器给的原因码（code 不给按 session_revoked），查 session_fate 和 lemo.authloss 记录用。
 * marked：记号已由别的标签页写好（跟着登录过期）。这一页已经在退出时什么也不做（exited，查服务器之前就标上）
 */
export async function exitDevice(
  facts: { reason: ExitReason; sid: string | null; path: AuthLossPath; code?: string; status?: number | undefined; lossSid?: string | null | undefined; revoked?: boolean; marked?: boolean },
  deps: ExitDeps,
): Promise<void> {
  const boot = deps.getBoot();
  const key = boot ?? NO_BOOT;
  if (exited.has(key)) return;
  // 交接设备行结果不确定、新会话还在内存里（core/rebind-pending.ts）：先做完交接，换上了就不是被移除，不退出、不清库
  const rescued = facts.reason === 'removed' ? rescueByRebind() : null;
  if (rescued) {
    if (await rescued) {
      boot?.outbox?.suspend(false);
      rlog('exit skip: rebound');
      return (deps.reload ?? reloadPage)();
    }
    if (exited.has(key)) return;
  }
  let fate: AuthLossOutcome | undefined;
  if (facts.reason === 'removed' && boot) {
    exited.add(key);
    const { sid, lossSid, path, status } = facts;
    fate = await confirmRemoved(boot, { sid, lossSid, path, code: facts.code ?? 'session_revoked', status }, deps);
  }
  rlog(`exit reason=${facts.reason} path=${facts.path} fate=${fate ?? '-'}`);
  const plan = decideExit({ reason: facts.reason, ...(fate ? { fate } : {}), ...(facts.revoked ? { revoked: true } : {}) });
  if (plan.act === 'stay') return;
  exited.add(key);
  // fate 为 expired 说明 confirmRemoved 已写成记号（写不成会直接回 removed）
  return runExit(boot, plan, facts.sid, deps, { marked: fate === 'expired' || facts.marked === true, dropped: fate !== undefined });
}

/** 别的标签页 SIGNED_OUT 写记号要晚几毫秒：storage 事件一来先等这么久再读（R-382） */
export const REAUTH_GRACE_MS = 1000;

/**
 * 会话没了（core/account.ts 的 watchAccount 设好闸以后交来；main.tsx 接上）：
 * 本页 SIGNED_OUT 按被移除先查服务器（码取刷新失败的记录，没有按 'none'）；
 * 别的标签页删了会话：等 graceMs 再读 lemo.reauth，是本账号的就跟着登录过期（记号那边已写，只关库），否则跟着清库
 */
export function exitOnSessionLoss(loss: SessionLoss, deps: ExitDeps, graceMs = 0): void {
  if (loss.here) {
    const f = loss.failure;
    void exitDevice({ reason: 'removed', sid: loss.sid, lossSid: f?.sid, path: 'sdk', code: f?.code ?? 'none', status: f?.status ?? 0 }, deps);
    return;
  }
  // 跟着别的标签页退出不停上传器（改前也不停）；队列照样在 wipeLocal 里清，那边退出时已清过同一个账号的，再清一次无害
  const followDeps: ExitDeps = { ...deps, clearLogs: () => undefined };
  const follow = (): void => {
    const r = readReauth();
    const mine = r !== null && r.user_id === deps.getBoot()?.userId;
    void exitDevice(mine ? { reason: 'expired', sid: r.session_id, path: 'sdk', marked: true } : { reason: 'followed', sid: null, path: 'sdk' }, followDeps);
  };
  if (graceMs > 0) setTimeout(follow, graceMs);
  else follow();
}

/** 测试用 */
export function resetExitForTest(): void {
  exited = new WeakSet<object>();
}
