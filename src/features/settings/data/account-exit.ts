// 注销申请成功、或导出时发现账号停用 / 在冷静期以后离开这台设备（R-256 ⑤；架构 0.29 续第 131 条②、4.3“被移除或被退出”）
// 不调 signOut、不删 devices 行：服务器在申请注销的同一个事务里已吊销这个账号的全部会话（含本机这个），
// 和“被移除”同一套——用现有出口 core/account 的 wipeOnRemoved（设闸 → 清本机库、运行时缓存 → 关库），顺序同
// app/sync-wiring.ts 的 onRemoved 和 onboarding 的 consent-exit：
//   ① 同一个同步段里 clearLocalSessionIf(sid)、清日志上传队列（lemo.logq.<user_id>）
//   ② wipeOnRemoved：设闸 → 清本机库、运行时缓存 → 关库
//   ③ 清完：再清一次日志队列（清库那几秒里又记的）→ 广播 reset（别的标签页整份重读，读到空库）→ 再 clearLocalSessionIf(sid)
//      （旧会话被晚到的令牌刷新写回时删；别的标签页刚登录的新会话不动）→ goToAuth(退出原因)，登录页按原因提示
// sid 是发注销请求用的那个会话（account-api 随结果带回，K6-sugg4 ①）。已经在走别的退出流程（boot.switching）时什么也不做
// • 删会话之前先广播一条带退出原因的 reset（DISABLED-probe-later ②）：别的标签页收到先记下同一条原因（app/sync-wiring.ts 的 onMessage），
//   它们随后因会话没了回登录页时显示同一条提示；清完库那条 reset 照旧不带原因
// • leaveForDisabled：设置页收到 account_disabled 先探测再定（R-256 ③；platform/account-status.ts 的 exitForDisabled，和 sync-wiring、
//   告知页同一份）：冷静期 → pending_deletion；已停用 → disabled；signed_out → 交给 onRevoked（被移除）；探测不出 → fallback；
//   active → 不离开（返回 false，调用方只提示）
import { wipeOnRemoved } from '../../../core/account.ts';
import { getBoot, type BootResult } from '../../../core/boot.ts';
import { clearLogQueue } from '../../../platform/log-store.ts';
import { exitForDisabled } from '../../../platform/account-status.ts';
import { clearCacheStorage, clearLocalSessionIf, goToAuth, type ExitNotice } from '../../../platform/session.ts';
import { postSyncMessage, syncChannelName } from '../../../platform/tab-leader.ts';

/** 回登录页时的提示：冷静期（auth.exit.pendingDeletion）、已停用（auth.exit.disabled）或探测不出（auth.exit.disabledUnsure） */
export type AccountLeaveNotice = 'pending_deletion' | 'disabled' | 'disabled_unsure';

export interface AccountLeaveDeps {
  getBoot(): BootResult | null;
  wipeOnRemoved: typeof wipeOnRemoved;
  clearCacheStorage(): Promise<void>;
  /** 给 user_id 只清这个账号的，null 清全部 lemo.logq.* */
  clearLogs(userId: string | null): void;
  /**
   * 告诉别的标签页（BroadcastChannel 'lemo-sync:<user_id>' 发 reset）：给了 exit 时带上退出原因和被拒的 sid（删会话之前发），
   * 不给是清完库那一条（本机库已清，整份重读）
   */
  broadcastReset(userId: string, exit?: { notice: ExitNotice; sid: string | null }): void;
  clearLocalSessionIf(sessionId: string | null): void;
  goToAuth(notice: AccountLeaveNotice): void;
}

export const defaultAccountLeaveDeps: AccountLeaveDeps = {
  getBoot,
  wipeOnRemoved,
  clearCacheStorage,
  clearLogs: (userId) => clearLogQueue(userId),
  broadcastReset: (userId, exit) => postSyncMessage(syncChannelName(userId), { type: 'reset', ...(exit ?? {}) }),
  clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
  goToAuth: (notice) => goToAuth(notice),
};

export type LeaveAccount = (notice: AccountLeaveNotice, sid: string | null) => Promise<void>;

/** 一个页面只离开一次（返回的函数自己记着）；测试每次新建一个 */
export function createLeaveAccount(deps: AccountLeaveDeps = defaultAccountLeaveDeps): LeaveAccount {
  let leaving = false;
  return (notice, sid) => {
    if (leaving) return Promise.resolve();
    const boot = deps.getBoot();
    if (boot?.switching) return Promise.resolve();
    leaving = true;
    const userId = boot ? boot.userId : null;
    const drop = (): void => {
      try {
        deps.clearLocalSessionIf(sid);
      } catch {
        // 存储不可用：本来也存不下会话
      }
    };
    if (userId) {
      try {
        deps.broadcastReset(userId, { notice, sid });
      } catch {
        // 提醒丢了不要紧：别的标签页回登录页时只是没有原因
      }
    }
    drop();
    deps.clearLogs(userId);
    const finish = (): void => {
      deps.clearLogs(userId);
      if (userId) {
        try {
          deps.broadcastReset(userId);
        } catch {
          // 提醒丢了不要紧
        }
      }
      drop();
      deps.goToAuth(notice);
    };
    if (!boot) {
      finish();
      return Promise.resolve();
    }
    return deps.wipeOnRemoved(boot, { clearCacheStorage: deps.clearCacheStorage, onRemoved: finish });
  };
}

export interface DisabledLeaveDeps {
  leave: LeaveAccount;
  /** 探测说会话已失效（signed_out）：走“被移除”（useSessionExit.onRevoked） */
  onRevoked(sid: string | null): void;
  /** 测试用：换掉 exitForDisabled */
  resolve?: (sid: string | null, fallback?: ExitNotice) => Promise<ExitNotice | 'active'>;
}

/**
 * 收到 account_disabled：先探测再定（见文件头）。true = 已离开或交给了 onRevoked；false = 账号正常（active），没离开，调用方照常提示。
 * fallback：探测不出时的原因——settings-api（RLS 一路，分不清）不给，按 disabled_unsure；account-api（经 requireActiveUser，码精确）给 'disabled'
 */
export async function leaveForDisabled(sid: string | null, d: DisabledLeaveDeps, fallback?: AccountLeaveNotice): Promise<boolean> {
  const r = await (d.resolve ?? ((s: string | null, f?: ExitNotice) => exitForDisabled(s, f ? { fallback: f } : {})))(sid, fallback);
  if (r === 'active') return false;
  if (r === 'removed') d.onRevoked(sid);
  else await d.leave(r, sid);
  return true;
}
