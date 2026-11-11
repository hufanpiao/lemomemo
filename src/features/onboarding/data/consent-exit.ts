// 告知页里会话不认、账号停用时离开这台设备：一律交给 core/device-exit.ts 的 exitDevice（被移除先经服务器确认才清库，Q-19）
// account_disabled 先探测（platform/account-status.ts 的 exitForDisabled）：active 不离开、留在告知页可以再点一次；
// 探测期间不删会话（探测要用它的令牌），探测完别的退出流程已接手（boot.switching）就什么也不做
import { defaultExitDeps, exitDevice, exitStarted, resetExitForTest, type ExitDeps } from '../../../core/device-exit.ts';
import { exitForDisabled } from '../../../platform/account-status.ts';
import type { ExitNotice } from '../../../platform/session.ts';

export type LeaveCode = 'session_revoked' | 'account_disabled';

export interface LeaveDeps extends ExitDeps {
  /** account_disabled 先探测（默认 exitForDisabled） */
  resolveDisabled?: (sid: string | null) => Promise<ExitNotice | 'active'>;
}

export const defaultLeaveDeps: LeaveDeps = defaultExitDeps;

/**
 * sid：被拒那次请求用的会话（必填，离开时只删它）。
 * false = 探测说账号正常（active），没离开、留在告知页（调用方提示“这一步没记下，请再点一次”）；其余为 true
 */
export async function leaveThisDevice(code: LeaveCode, sid: string | null, deps: LeaveDeps = defaultLeaveDeps): Promise<boolean> {
  const boot = deps.getBoot();
  if (boot?.switching || exitStarted(boot)) return true;
  if (code === 'account_disabled') {
    const r = await (deps.resolveDisabled ?? ((s: string | null) => exitForDisabled(s)))(sid);
    if (deps.getBoot()?.switching) return true;
    if (r === 'active') return false;
    await exitDevice({ reason: r, sid, path: 'consent' }, deps);
    return true;
  }
  await exitDevice({ reason: 'removed', sid, path: 'consent' }, deps);
  return true;
}

/** 测试用 */
export const resetLeaveForTest = resetExitForTest;
