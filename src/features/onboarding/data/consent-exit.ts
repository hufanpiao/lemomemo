// 告知页里会话不认、账号停用时离开这台设备（架构 4.1“被移除或被退出”、4.3 ②；接手清单 CONSENT-wire ④）
// 不另写一套：调现有的出口 core/account 的 wipeOnRemoved（设闸 → 清空本机库和运行时缓存 → 关库），清完记下退出原因、回登录页——
// 和 app/sync-wiring.ts 的 onRemoved 同一顺序；退出原因按服务器码定（platform/session.ts 的 exitNoticeOf）：
// session_revoked → removed（登录页 auth.exit.removed）。
// account_disabled 先探测再定（R-256 ③、DISABLED-probe-later ①；record_consent 一路按 is_active() 判断，停用和冷静期都回它）：
//   platform/account-status.ts 的 exitForDisabled（和 sync-wiring 同一份）：pending_deletion → 冷静期提示；disabled → 已停用；
//   signed_out → removed；探测不出 → disabled_unsure；active（刚好恢复了）→ 不离开、不清本机，留在告知页可以再点一次。
//   探测期间（最多 8 秒）先不删会话——探测要用它的令牌；探测完别的退出流程已接手（boot.switching）就什么也不做
// • 已经在走别的退出流程（boot.switching：换账号、同步层的被移除、退出登录）：什么也不做，不清第二遍、不跳第二次
// • 没启动过（getBoot() 为 null）：没有库可清，删会话、记原因、回登录页
// • 这个账号的日志上传队列（localStorage lemo.logq.<user_id>）一起清（架构 0.38 第 68 条 ⑤；审查 M1）：wipeOnRemoved 之前清一次，
//   清完回登录页前再清一次兜底（清库那几秒里可能又记了几条）；sealForExit 设了 switching 以后 sync-wiring 的 onRemoved、
//   watchAccount 都会跳过，它们的 clearLogs 不会替这里清。没启动过（没有 boot）读不到账号，按 sign-out.ts 的写法传 null，清掉全部 lemo.logq.*
// • 删本机会话只删被拒那次请求用的会话（接手清单 K6-sugg3 ①、K6-sugg4 ①）：调用方把 consent-api 随错误带回的 sid 传进来
//   （发请求前记下的），决定离开的同一个同步段里就 clearLocalSessionIf(sid)，清完库、回登录页前再 clearLocalSessionIf(sid) 一次——
//   请求在路上、清库那几秒里别的标签页用同一账号或别的账号刚登录的新会话都不删；旧会话被晚到的令牌刷新写回时照样删掉
// • 删会话、清库之前先广播一条带退出原因的 reset（SESS-1030-sugg ①，和设置页 settings/data/account-exit.ts、app/sync-wiring.ts 的 leave 一致）：
//   BroadcastChannel 'lemo-sync:<user_id>' 发 {type: 'reset', notice, sid}。别的标签页收到先记下同一条原因；冷静期那边不删会话、
//   收不到 storage 事件，靠这条跟着清库回登录页（R-263），不用等自己的请求被拒。本页自己的 TabLeader 也会收到（临时频道是另一个对象），
//   那时 wipeOnRemoved 已设 switching，sync-wiring 不会再走第二遍。没启动过（没有 boot、读不到账号）不发
// 不新挂任何监听（SIGNED_OUT 那一路归会话层）
import { wipeOnRemoved } from '../../../core/account.ts';
import { getBoot, type BootResult } from '../../../core/boot.ts';
import { clearLogQueue } from '../../../platform/log-store.ts';
import { exitForDisabled } from '../../../platform/account-status.ts';
import {
  clearCacheStorage, clearLocalSessionIf, exitNoticeOf, goToAuth, setExitNotice, type ExitNotice,
} from '../../../platform/session.ts';
import { postSyncMessage, syncChannelName } from '../../../platform/tab-leader.ts';

export type LeaveCode = 'session_revoked' | 'account_disabled';

export interface LeaveDeps {
  getBoot(): BootResult | null;
  wipeOnRemoved: typeof wipeOnRemoved;
  clearCacheStorage(): Promise<void>;
  setExitNotice(n: ExitNotice): void;
  /** 本机会话还是这个 session_id 才删（platform/session.ts 的 clearLocalSessionIf） */
  clearLocalSessionIf(sessionId: string | null): void;
  goToAuth(): void;
  /** 清日志上传队列：给 user_id 只清这个账号的，null 清全部 lemo.logq.* */
  clearLogs(userId: string | null): void;
  /** 告诉别的标签页退出原因（BroadcastChannel 'lemo-sync:<user_id>' 发带 notice、sid 的 reset；删会话、清库之前发，见文件头） */
  broadcastReset(userId: string, exit: { notice: ExitNotice; sid: string | null }): void;
  /** account_disabled 先探测（默认 platform/account-status.ts 的 exitForDisabled） */
  resolveDisabled?: (sid: string | null) => Promise<ExitNotice | 'active'>;
}

export const defaultLeaveDeps: LeaveDeps = {
  getBoot, wipeOnRemoved, clearCacheStorage, setExitNotice, goToAuth, clearLogs: (userId) => clearLogQueue(userId),
  clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
  broadcastReset: (userId, exit) => postSyncMessage(syncChannelName(userId), { type: 'reset', ...exit }),
};

let leaving = false;

/**
 * 只处理一次；sid：被拒那次请求用的会话（必填，K6-sugg4 ①②）。返回清理做完的 Promise：
 * false = 探测说账号正常（active），没离开、留在告知页（调用方提示“这一步没记下，请再点一次”）；其余（离开了、不用处理）为 true
 */
export function leaveThisDevice(code: LeaveCode, sid: string | null, deps: LeaveDeps = defaultLeaveDeps): Promise<boolean> {
  if (leaving) return Promise.resolve(true);
  if (deps.getBoot()?.switching) return Promise.resolve(true);
  leaving = true;
  if (code !== 'account_disabled') return leaveNow(exitNoticeOf(code), sid, deps).then(() => true);
  return (async () => {
    const r = await (deps.resolveDisabled ?? ((s: string | null) => exitForDisabled(s)))(sid);
    if (deps.getBoot()?.switching) return true;   // 探测期间别的退出流程接手了
    if (r === 'active') {
      leaving = false;   // 账号正常：留在告知页，可以再点一次
      return false;
    }
    await leaveNow(r, sid, deps);
    return true;
  })();
}

/** 清本机、记退出原因、回登录页（顺序见文件头） */
function leaveNow(notice: ExitNotice, sid: string | null, deps: LeaveDeps): Promise<void> {
  const boot = deps.getBoot();
  // 同一个同步段里先删本机会话——只删被拒的那个（K6-sugg3 ①、K6-sugg4 ①）。
  // 冷静期不删（R-262 K6-pending-s2）：探测出冷静期说明被拒那次的会话还活着，删它没有安全收益、反而会误伤别的标签页刚登录的同账号 S2；
  // 清库、记退出原因、回登录页照旧，登录页 SessionCheck 探测出冷静期就地出恢复页
  const dead = sid;
  const userId = boot ? boot.userId : null;
  const drop = (): void => {
    if (notice === 'pending_deletion') return;
    try {
      deps.clearLocalSessionIf(dead);
    } catch {
      // 存储不可用：本来也存不下会话
    }
  };
  // 先告诉别的标签页（SESS-1030-sugg ①）：赶在删会话、清库之前
  if (userId) {
    try {
      deps.broadcastReset(userId, { notice, sid: dead });
    } catch {
      // 提醒丢了不要紧：别的标签页回登录页时只是没有原因（冷静期那边等自己的请求被拒再走）
    }
  }
  drop();
  deps.clearLogs(userId);
  const finish = (): void => {
    deps.clearLogs(userId);   // 兜底：清库期间又记下的
    deps.setExitNotice(notice);
    drop();   // 旧会话被晚到的令牌刷新写回时再删；别的标签页刚登录的新会话不动
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
