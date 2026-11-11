// 账号没了、会话没了怎么退出这台设备，只在这里做（架构约定 10.1）：decideExit 定结局（纯函数），exitDevice 执行，清库走 account.ts 的 wipeLocal
// 不变量：被移除必须先经服务器确认（session_fate 回 revoked）才清库，没确认只退出（R-382、Q-19）；停用、登录过期只退出不清库，
//   写不了 lemo.reauth 记号才退回清库；冷静期不删会话（会话还活着，R-262）；同一页只执行一次（exited）
// 顺序：（被移除：设闸、写记号、删会话、查服务器）→ 记号（只退出时）→ 广播带原因的 reset → 删被拒的那个会话
//   →（清库时）清日志队列、wipeLocal、再清日志、广播 reset、再删会话 → 回登录页
import { expireThisTab, markExpired, wipeLocal } from './account.ts';
import type { AuthLossOutcome, AuthLossPath, AuthLossSignal } from './auth-loss.ts';
import { resolveAuthLossLazy } from './auth-loss-lazy.ts';
import { getBoot, type BootResult } from './boot.ts';
import { clearLogQueue } from '../platform/log-store.ts';
import { rlog } from '../platform/run-log-api.ts';
import { clearCacheStorage, clearLocalSessionIf, goToAuth, type ExitNotice } from '../platform/session.ts';
import { postSyncMessage, syncChannelName } from '../platform/tab-leader.ts';

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
  /** 清日志上传队列：给 user_id 只清这个账号的，null 清全部 */
  clearLogs(userId: string | null): void;
  /** 告诉别的标签页：带 exit 的在删会话之前发；不带的是清完库那一条（整份重读） */
  broadcastReset(userId: string, exit?: { notice: ExitNotice; sid: string | null }): void;
  /** 记退出原因、回登录页；notice 为 null 不记 */
  goToAuth(notice: ExitNotice | null, sid: string | null): void;
  /** 查服务器定会话丢了的结局（默认 resolveAuthLoss，查 session_fate） */
  resolveAuthLoss(signal: AuthLossSignal): Promise<AuthLossOutcome>;
  /** 记一条日志（只有 act，例如 auth_loss_store_failed）；不填不记 */
  log?(act: string): void;
}

export const defaultExitDeps: ExitDeps = {
  getBoot,
  wipe: (boot) => wipeLocal(boot, { clearCacheStorage }),
  keep: (boot, notice, sid) => (notice === 'disabled' ? expireThisTab(boot, null, 'disabled') : expireThisTab(boot, sid)),
  clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
  clearLogs: (userId) => clearLogQueue(userId),
  broadcastReset: (userId, exit) => postSyncMessage(syncChannelName(userId), { type: 'reset', ...(exit ?? {}) }),
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

/**
 * 被移除先经服务器确认：设闸、写 lemo.reauth，同一个同步段里删被拒的那个会话，再查 session_fate。
 * 写不了记号（存储不可用）按 removed（退回清库，架构 4.1a 第 7 点）。查服务器出错按 expired
 */
async function confirmRemoved(boot: BootResult, s: { sid: string | null; path: AuthLossPath; code: string }, deps: ExitDeps): Promise<AuthLossOutcome> {
  const kept = markExpired(boot, s.sid);
  if (!kept) deps.log?.('auth_loss_store_failed');
  safe(() => void deps.clearLocalSessionIf(s.sid));
  if (!kept) return 'removed';
  try {
    return await deps.resolveAuthLoss({ path: s.path, code: s.code, sessionId: s.sid, userId: boot.userId });
  } catch {
    return 'expired';
  }
}

/** 按结局执行（顺序见文件头）。dropped：收到信号时已经删过一次会话（confirmRemoved） */
function runExit(boot: BootResult | null, plan: Exclude<ExitPlan, { act: 'stay' }>, sid: string | null, deps: ExitDeps, dropped: boolean): Promise<void> {
  const { notice } = plan;
  const userId = boot?.userId ?? null;
  if (boot) boot.sessionGone = true;
  const kept = plan.act === 'logout' && boot !== null && notice !== null && deps.keep(boot, notice, sid);
  rlog(`exit ${plan.act} notice=${notice ?? '-'} kept=${kept} boot=${boot !== null}`);
  if (userId && plan.broadcast && notice) safe(() => deps.broadcastReset(userId, { notice, sid }));
  const drop = (): void => (plan.dropSession ? safe(() => void deps.clearLocalSessionIf(sid)) : undefined);
  if (!dropped) drop();
  if (kept) {
    if (dropped) drop();   // 查服务器那几秒里旧会话被晚到的令牌刷新写回时再删
    deps.goToAuth(notice, sid);
    return Promise.resolve();
  }
  deps.clearLogs(userId);
  const finish = (): void => {
    deps.clearLogs(userId);   // 兜底：清库那几秒里又记下的
    if (userId && plan.broadcast) safe(() => deps.broadcastReset(userId));
    drop();   // 旧会话被晚到的令牌刷新写回时再删；别的标签页刚登录的新会话不动
    deps.goToAuth(notice, sid);
  };
  if (!boot) {
    finish();
    return Promise.resolve();
  }
  return deps.wipe(boot).then(finish, finish);
}

/**
 * 退出这台设备的唯一入口：reason 为 removed 时先经服务器确认（confirmRemoved），再 decideExit、runExit。
 * path、code：信号从哪来、服务器给的原因码（定要不要查 session_fate、lemo.authloss 记录用；不给按 session_revoked）。
 * 这一页已经在退出时什么也不做（“已在退出”只有 exited 这一个标志，查服务器之前就标上）
 */
export async function exitDevice(
  facts: { reason: ExitReason; sid: string | null; path: AuthLossPath; code?: string; revoked?: boolean },
  deps: ExitDeps,
): Promise<void> {
  const boot = deps.getBoot();
  const key = boot ?? NO_BOOT;
  if (exited.has(key)) return;
  let fate: AuthLossOutcome | undefined;
  if (facts.reason === 'removed' && boot) {
    exited.add(key);
    fate = await confirmRemoved(boot, { sid: facts.sid, path: facts.path, code: facts.code ?? 'session_revoked' }, deps);
  }
  rlog(`exit reason=${facts.reason} path=${facts.path} fate=${fate ?? '-'}`);
  const plan = decideExit({ reason: facts.reason, ...(fate ? { fate } : {}), ...(facts.revoked ? { revoked: true } : {}) });
  if (plan.act === 'stay') return;
  exited.add(key);
  return runExit(boot, plan, facts.sid, deps, fate !== undefined);
}

/** 测试用 */
export function resetExitForTest(): void {
  exited = new WeakSet<object>();
}
