// 告知页里会话不认、账号停用时离开这台设备（架构 4.1“被移除或被退出”、4.3 ②；接手清单 CONSENT-wire ④）
// 不另写一套：调现有的出口 core/account 的 wipeOnRemoved（设闸 → 清空本机库和运行时缓存 → 关库），清完记下退出原因、删本机会话、回登录页——
// 和 app/sync-wiring.ts 的 onRemoved 同一顺序；退出原因按服务器码定（platform/session.ts 的 exitNoticeOf）：
// session_revoked → removed（登录页 auth.exit.removed），account_disabled → disabled（auth.exit.disabled）
// • 已经在走别的退出流程（boot.switching：换账号、同步层的被移除、退出登录）：什么也不做，不清第二遍、不跳第二次
// • 没启动过（getBoot() 为 null）：没有库可清，直接记原因、删会话、回登录页
// • 这个账号的日志上传队列（localStorage lemo.logq.<user_id>）一起清（架构 0.38 第 68 条 ⑤；审查 M1）：wipeOnRemoved 之前清一次，
//   清完回登录页前再清一次兜底（清库那几秒里可能又记了几条）；sealForExit 设了 switching 以后 sync-wiring 的 onRemoved、
//   watchAccount 都会跳过，它们的 clearLogs 不会替这里清。没启动过（没有 boot）读不到账号，按 sign-out.ts 的写法传 null，清掉全部 lemo.logq.*
// 不新挂任何监听（SIGNED_OUT 那一路归会话层）
import { wipeOnRemoved } from '../../../core/account.ts';
import { getBoot, type BootResult } from '../../../core/boot.ts';
import { clearLogQueue } from '../../../platform/log-store.ts';
import { clearCacheStorage, clearLocalSession, exitNoticeOf, goToAuth, setExitNotice, type ExitNotice } from '../../../platform/session.ts';

export type LeaveCode = 'session_revoked' | 'account_disabled';

export interface LeaveDeps {
  getBoot(): BootResult | null;
  wipeOnRemoved: typeof wipeOnRemoved;
  clearCacheStorage(): Promise<void>;
  setExitNotice(n: ExitNotice): void;
  clearLocalSession(): void;
  goToAuth(): void;
  /** 清日志上传队列：给 user_id 只清这个账号的，null 清全部 lemo.logq.* */
  clearLogs(userId: string | null): void;
}

export const defaultLeaveDeps: LeaveDeps = {
  getBoot, wipeOnRemoved, clearCacheStorage, setExitNotice, clearLocalSession, goToAuth, clearLogs: (userId) => clearLogQueue(userId),
};

let leaving = false;

/** 只处理一次；返回清理做完（或不用清）的 Promise */
export function leaveThisDevice(code: LeaveCode, deps: LeaveDeps = defaultLeaveDeps): Promise<void> {
  if (leaving) return Promise.resolve();
  const boot = deps.getBoot();
  if (boot?.switching) return Promise.resolve();
  leaving = true;
  const userId = boot ? boot.userId : null;
  deps.clearLogs(userId);
  const finish = (): void => {
    deps.clearLogs(userId);   // 兜底：清库期间又记下的
    deps.setExitNotice(exitNoticeOf(code));
    deps.clearLocalSession();
    deps.goToAuth();
  };
  if (!boot) {
    finish();
    return Promise.resolve();
  }
  return deps.wipeOnRemoved(boot, { clearCacheStorage: deps.clearCacheStorage, onRemoved: finish });
}

/** 测试用 */
export function resetLeaveForTest(): void {
  leaving = false;
}
