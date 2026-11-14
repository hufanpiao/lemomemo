// 设置页本人退出这台设备（架构 4.1）：顺序、超时、晚到处理在 platform/sign-out.ts 的 signOutThisDevice（和登录页共用），清本机走同一个 wipeThisDevice
// 不变量：跳登录页等清理做完（最多 LEAVE_WAIT_MAX_MS）；跳之前再删一次本机会话，只删退出前那一个（别的标签页的新会话不删）
// 会话不认、本机已没有会话不在这里：useSettingsPage 交给 core/device-exit.ts 的 exitDevice（第三方审查前端-4：原来这里另有一条清库管线，不认 exited）
// 详细理由见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import { useCallback, useEffect, useRef, useState } from 'react';
import { dropSession, sessionIdOf, SIGN_OUT_TIMEOUT_MS, signOutThisDevice, withTimeout } from '../../../platform/sign-out.ts';
import { defaultExitDeps, type ExitDeps } from '../data/local.ts';
import type { SettingsApi } from '../data/settings-api.ts';

export type { ExitDeps } from '../data/local.ts';

/** 提示后自动跳回登录页的等待时间 */
export const REVOKED_REDIRECT_MS = 5000;
/** “退出这台设备”服务器部分（删本机行 + signOut）的总超时，同登录页 K4 */
export const EXIT_TIMEOUT_MS = SIGN_OUT_TIMEOUT_MS;
/**
 * 跳登录页前最多等清理多久（清理本身各步另有上限，这里再兜一层）。最坏：清库 3 + 按库名删库 3 + 缓存 2 + 再删一次库 3 = 11 秒，
 * 所以等 11 秒，第 ⑤ 步（会话删掉后再删一次库）也能做完
 */
export const LEAVE_WAIT_MAX_MS = 11000;

/** 退出前数没上传的最多等多久 */
export const COUNT_TIMEOUT_MS = 2500;

/** 离开前给用户看的那一句：只剩服务器没退成（会话不认、本机没有会话由 exitDevice 回登录页再提示） */
export type ExitNotice = 'offline_signout';

export interface ExitTiming {
  redirectMs?: number;
  countTimeoutMs?: number;
  exitTimeoutMs?: number;
  leaveWaitMs?: number;
}


export function useSessionExit(api: SettingsApi, exit: ExitDeps = defaultExitDeps, timing: ExitTiming = {}) {
  const redirectMs = timing.redirectMs ?? REVOKED_REDIRECT_MS;
  const exitTimeoutMs = timing.exitTimeoutMs ?? EXIT_TIMEOUT_MS;
  const leaveWaitMs = timing.leaveWaitMs ?? LEAVE_WAIT_MAX_MS;
  const countTimeoutMs = timing.countTimeoutMs ?? COUNT_TIMEOUT_MS;
  const [notice, setNotice] = useState<ExitNotice | null>(null);
  /** 正在退出这台设备（点了退出到跳走或弹提示之间，最长约 19 秒）：界面显示“正在退出…” */
  const [signingOut, setSigningOut] = useState(false);
  /** 清理还没做完（“去登录”按钮禁用） */
  const [cleaning, setCleaning] = useState(false);
  const exiting = useRef(false);
  const cleanup = useRef<Promise<void> | null>(null);
  const left = useRef(false);
  /**
   * 退出前读的本机会话 session_id（K6-sugg3 ①）：先记下再走到 leave，没记下（null）时 clearLocalSessionIf(null) 只在本机没有会话时删，等于不删别人的
   */
  const deadSid = useRef<string | null>(null);

  /** 再删一次本机会话：只在本机会话还是 deadSid 时才删，别的标签页刚登录的新会话不删 */
  const clearSession = useCallback(() => dropSession(exit, deadSid.current), [exit]);

  /** 记下清理进度；跳转前要等它 */
  const track = useCallback((p: Promise<void>): Promise<void> => {
    cleanup.current = p;
    setCleaning(true);
    void p.finally(() => setCleaning(false));
    return p;
  }, []);

  /**
   * 去登录页：先等清理做完（最多 leaveWaitMs），跳之前再同步删一次本机会话；只跳一次。
   * 跳转抛错（location 被拦等）：复位，让“去登录”可以再点；放开 wipe 占住的“忙”，库已因升级关掉时升级中心会自己重新载入
   */
  const leave = useCallback(async () => {
    if (left.current) return;
    left.current = true;
    const p = cleanup.current;
    if (p) await withTimeout(() => p, leaveWaitMs, () => undefined);
    void clearSession();   // 不抛错；goToAuth 在 exe 里自己等删除回来（A-1）
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
  }, [exit, leaveWaitMs, clearSession]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => void leave(), redirectMs);
    return () => clearTimeout(id);
  }, [notice, leave, redirectMs]);

  const goToAuth = useCallback(() => void leave(), [leave]);

  /** 退出这台设备（“退出登录”和“移除本机”都走这里）：删行 → 清本机 → 清会话；服务器那边没退成先提示 */
  const signOutHere = useCallback(
    async (currentDeviceId: string | null) => {
      if (exiting.current) return;
      exiting.current = true;
      setSigningOut(true);
      // 退出前的会话（K6-sugg3 ①）：兜底删会话、跳登录页前再删一次都只删它
      deadSid.current = sessionIdOf(exit);
      const sid = deadSid.current;
      // 顺序、超时、晚到处理都在 platform/sign-out.ts（和登录页共用）
      const run = signOutThisDevice({
        // prior = 退出一开头记下的旧会话：settings-api 紧贴 signOut 前判断会话换没换，换了用旧令牌直接 logout（K6-signout-lib）
        server: { deleteOwnDevice: () => api.deleteOwnDevice(currentDeviceId), signOut: (prior) => api.dropLocalSession(sid, prior) },
        steps: exit,
        readUserId: () => exit.readUserId(),
        timeoutMs: exitTimeoutMs,
      }).then((r) => r.serverDone);
      void track(run.then(() => undefined));
      const serverDone = await run;
      if (serverDone) void leave();
      else {
        setSigningOut(false);
        setNotice('offline_signout');
      }
    },
    [api, exit, exitTimeoutMs, track, leave],
  );

  /** 退出前数没上传的；读库卡住时最多等 countTimeoutMs，按“数不出来”（null，照样先确认）处理 */
  const pendingCount = useCallback(
    () => withTimeout(() => exit.pendingCount(), countTimeoutMs, (): number | null => null),
    [exit, countTimeoutMs],
  );

  return { notice, cleaning, signingOut, goToAuth, signOutHere, pendingCount };
}
