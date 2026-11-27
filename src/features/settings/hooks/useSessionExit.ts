// 设置页本人退出这台设备：顺序、超时、晚到处理在 platform/sign-out.ts 的 signOutThisDevice（和登录页共用），清本机走同一个 wipeThisDevice
// 不变量：发任何请求之前先 beginExit（core/device-exit.ts：设闸、登记“这一页已经在退出”），同步层、设置页请求这期间再发现会话没了不另退一遍
// 不变量：清理做完（signOutThisDevice 返回）才跳登录页；跳之前再删一次本机会话，只删退出前那一个（别的标签页的新会话不删）
// 会话不认、本机已没有会话不在这里：useSettingsPage 交给 core/device-exit.ts 的 exitDevice
import { useCallback, useEffect, useRef, useState } from 'react';
import { withTimeout } from '../../../platform/exit-basics.ts';
import { dropSession, sessionIdOf, signOutThisDevice } from '../../../platform/sign-out.ts';
import { defaultSignOutHereDeps, type SignOutHereDeps } from '../data/local.ts';
import type { SettingsApi } from '../data/settings-api.ts';

export type { SignOutHereDeps } from '../data/local.ts';

/** 提示后自动跳回登录页的等待时间 */
export const REVOKED_REDIRECT_MS = 5000;

/** 退出前数没上传的最多等多久 */
export const COUNT_TIMEOUT_MS = 2500;

/** 离开前给用户看的那一句：只剩服务器没退成（会话不认、本机没有会话由 exitDevice 回登录页再提示） */
export type SignOutNotice = 'offline_signout';

export interface ExitTiming {
  redirectMs?: number;
  countTimeoutMs?: number;
  /** 服务器那一半（删本机行 + signOut）的总超时；默认 platform/sign-out.ts 的 SIGN_OUT_TIMEOUT_MS */
  exitTimeoutMs?: number;
}

export function useSessionExit(api: SettingsApi, exit: SignOutHereDeps = defaultSignOutHereDeps, timing: ExitTiming = {}) {
  const redirectMs = timing.redirectMs ?? REVOKED_REDIRECT_MS;
  const countTimeoutMs = timing.countTimeoutMs ?? COUNT_TIMEOUT_MS;
  const [notice, setNotice] = useState<SignOutNotice | null>(null);
  /** 正在退出这台设备（点了退出到跳走或弹提示之间）：界面显示“正在退出…” */
  const [signingOut, setSigningOut] = useState(false);
  const exiting = useRef(false);
  const left = useRef(false);
  /**
   * 退出前读的本机会话 session_id：先记下再走到 leave，没记下（null）时 clearLocalSessionIf(null) 只在本机没有会话时删，等于不删别人的
   */
  const deadSid = useRef<string | null>(null);

  /**
   * 去登录页：跳之前再同步删一次本机会话；只跳一次。
   * 跳转抛错（location 被拦等）：复位，让“去登录”可以再点；放开 wipe 占住的“忙”，库已因升级关掉时升级中心会自己重新载入
   */
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    void dropSession(exit, deadSid.current);   // 不抛错；goToAuth 在 exe 里自己等删除回来
    try {
      exit.goToAuth();
    } catch {
      left.current = false;
      try {
        exit.releaseHold?.();
      } catch {
        // 同上
      }
    }
  }, [exit]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(leave, redirectMs);
    return () => clearTimeout(id);
  }, [notice, leave, redirectMs]);

  /** 退出这台设备（“退出登录”和“移除本机”都走这里）：登记退出 → 删行 → 清本机 → 清会话；服务器那边没退成先提示 */
  const signOutHere = useCallback(
    async (currentDeviceId: string | null) => {
      if (exiting.current) return;
      exiting.current = true;
      exit.beginExit();
      setSigningOut(true);
      // 退出前的会话：兜底删会话、跳登录页前再删一次都只删它
      deadSid.current = sessionIdOf(exit);
      const sid = deadSid.current;
      // 顺序、超时、晚到处理都在 platform/sign-out.ts（和登录页共用）
      const { serverDone } = await signOutThisDevice({
        // prior = 退出一开头记下的旧会话：settings-api 紧贴 signOut 前判断会话换没换，换了用旧令牌直接 logout
        server: { deleteOwnDevice: () => api.deleteOwnDevice(currentDeviceId), signOut: (prior) => api.dropLocalSession(sid, prior) },
        steps: exit,
        readUserId: () => exit.readUserId(),
        ...(timing.exitTimeoutMs === undefined ? {} : { timeoutMs: timing.exitTimeoutMs }),
      });
      if (serverDone) leave();
      else {
        setSigningOut(false);
        setNotice('offline_signout');
      }
    },
    [api, exit, timing.exitTimeoutMs, leave],
  );

  /** 退出前数没上传的；读库卡住时最多等 countTimeoutMs，按“数不出来”（null，照样先确认）处理 */
  const pendingCount = useCallback(
    () => withTimeout(() => exit.pendingCount(), countTimeoutMs, (): number | null => null),
    [exit, countTimeoutMs],
  );

  return { notice, signingOut, goToAuth: leave, signOutHere, pendingCount };
}
