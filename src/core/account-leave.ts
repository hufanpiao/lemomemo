// 设置页、随手记插图上传离开本机（被移除、停用、冷静期、注销后）：一律交给 core/device-exit.ts 的 exitDevice
// • 已经在走别的退出流程（boot.switching）时什么也不做；例外 deletion_unsure：闸是“会话没了”那一路设的（boot.sessionGone）时只记下原因，
//   那一路最后的 goToAuth('removed') 见已有原因就不覆盖，登录页显示“没能确认注销”
// • leaveForDisabled：account_disabled 先探测（platform/account-status.ts 的 exitForDisabled）再定；signed_out 交给 onRevoked，active 不离开
import type { AuthLossPath } from './auth-loss.ts';
import { defaultExitDeps, exitDevice, type ExitDeps } from './device-exit.ts';
import { exitForDisabled, type ProbedExit } from '../platform/account-status.ts';
import { setExitNotice } from '../platform/session.ts';
import { postReset } from '../platform/tab-leader.ts';

/** 回登录页时的提示：冷静期、已停用、探测不出、申请注销后确认不了办没办成（deletion-check.ts）、被移除 */
export type AccountLeaveNotice = 'pending_deletion' | 'disabled' | 'disabled_unsure' | 'deletion_unsure' | 'removed';

export interface AccountLeaveDeps extends ExitDeps {
  /** 只记下退出原因、不跳转（见文件头 deletion_unsure） */
  setNotice(notice: AccountLeaveNotice, sid: string | null): void;
  /** 信号从哪来（lemo.authloss 记录用）；默认 files */
  authPath?: AuthLossPath;
}

export const defaultAccountLeaveDeps: AccountLeaveDeps = {
  ...defaultExitDeps,
  broadcastReset: postReset,
  // 清完库再发一条不带原因的 reset：设置页、插图上传原来就发（别的标签页整份重读，读到空库）
  broadcastWiped: (userId) => postReset(userId),
  setNotice: (notice, sid) => setExitNotice(notice, undefined, { sid }),
};

/** revoked：注销申请成功，服务器已吊销全部会话 */
export type LeaveAccount = (notice: AccountLeaveNotice, sid: string | null, o?: { revoked?: boolean }) => Promise<void>;

export function createLeaveAccount(deps: AccountLeaveDeps = defaultAccountLeaveDeps): LeaveAccount {
  return (notice, sid, o) => {
    const boot = deps.getBoot();
    if (boot?.switching) {
      if (notice === 'deletion_unsure' && boot.sessionGone) deps.setNotice(notice, sid);
      return Promise.resolve();
    }
    return exitDevice({ reason: notice, sid, path: deps.authPath ?? 'files', ...(o?.revoked ? { revoked: true } : {}) }, deps);
  };
}

export interface DisabledLeaveDeps {
  leave: LeaveAccount;
  /** 探测说会话已失效（signed_out）：走“被移除”（useSessionExit.onRevoked） */
  onRevoked(sid: string | null): void;
  /** 测试用：换掉 exitForDisabled */
  resolve?: (sid: string | null, fallback?: ProbedExit) => Promise<ProbedExit | 'active'>;
}

/**
 * 收到 account_disabled：先探测再定。true = 已离开或交给了 onRevoked；false = 账号正常（active），没离开，调用方照常提示。
 * fallback：探测不出时的原因——settings-api（RLS 一路，分不清）不给，按 disabled_unsure；account-api（码精确）给 'disabled'
 */
export async function leaveForDisabled(sid: string | null, d: DisabledLeaveDeps, fallback?: AccountLeaveNotice): Promise<boolean> {
  const r = await (d.resolve ?? ((s: string | null, f?: ProbedExit) => exitForDisabled(s, f ? { fallback: f } : {})))(sid, fallback);
  if (r === 'active') return false;
  if (r === 'removed') d.onRevoked(sid);
  else await d.leave(r, sid);
  return true;
}
