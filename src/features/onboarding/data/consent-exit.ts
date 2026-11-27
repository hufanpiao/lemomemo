// 告知页里会话不认、账号停用时离开这台设备：一律交给 core/device-exit.ts 的 exitDevice（被移除先经服务器确认才清库）
// account_disabled 先探测再定（core/account-leave.ts 的 exitForAccountDisabled，和主 App、设置页同一个入口）：active 不离开、留在告知页可以再点一次；
// 探测期间不删会话（探测要用它的令牌）、再点（不管哪种码）都当已在处理；探测完别的退出流程已接手（boot.switching）就什么也不做
import { createDisabledGate, exitForAccountDisabled, type DisabledGate, type DisabledGateDeps } from '../../../core/account-leave.ts';
import { defaultExitDeps, exitDevice, exitStarted, resetExitForTest, type ExitDeps } from '../../../core/device-exit.ts';
import type { ProbedExit } from '../../../platform/account-status.ts';
import { postReset } from '../../../platform/tab-leader.ts';

export type LeaveCode = 'session_revoked' | 'account_disabled';

export interface LeaveDeps extends ExitDeps {
  /** 测试用：换掉 account_disabled 的探测（默认 platform/account-status.ts 的 probeForSid） */
  resolveDisabled?: DisabledGateDeps['resolve'];
}

export const defaultLeaveDeps: LeaveDeps = { ...defaultExitDeps, broadcastReset: postReset };

/** 告知页的探测闸（一页只有一个告知页）；换了探测函数（测试）就另建一个 */
let gate: DisabledGate = createDisabledGate();
let gateProbe: LeaveDeps['resolveDisabled'];

function gateOf(deps: LeaveDeps): DisabledGate {
  if (deps.resolveDisabled !== gateProbe) {
    gateProbe = deps.resolveDisabled;
    gate = createDisabledGate(gateProbe ? { resolve: gateProbe } : {});
  }
  return gate;
}

/**
 * sid：被拒那次请求用的会话（必填，离开时只删它）。
 * false = 探测说账号正常（active），没离开、留在告知页（调用方提示“这一步没记下，请再点一次”）；其余为 true
 */
export async function leaveThisDevice(code: LeaveCode, sid: string | null, deps: LeaveDeps = defaultLeaveDeps): Promise<boolean> {
  const g = gateOf(deps);
  const boot = deps.getBoot();
  if (g.busy() || boot?.switching || exitStarted(boot)) return true;
  if (code === 'session_revoked') {
    await exitDevice({ reason: 'removed', sid, path: 'consent' }, deps);
    return true;
  }
  const leave = (reason: ProbedExit, s: string | null): Promise<void> => exitDevice({ reason, sid: s, path: 'consent' }, deps);
  return (await exitForAccountDisabled(sid, { gate: g, getBoot: deps.getBoot, leave })) !== 'active';
}

/** 测试用 */
export function resetLeaveForTest(): void {
  gate = createDisabledGate();
  gateProbe = undefined;
  resetExitForTest();
}
