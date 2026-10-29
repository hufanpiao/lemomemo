// 离开这台设备（架构 4.1、0.29 续第 98 条、0.38 第 7 条；K9 第二轮审查 N1、N2、L1）
// • 被移除 / 被退出 / 会话不认（session_revoked、unauthorized、401、刷新失败）：先清本机库和 Cache Storage，
//   清完马上同步删本机会话（clearLocalSession；服务器上的会话已经没了，不用等 signOut），signOut local 放后台调、不等它；
//   提示“这台设备已在别的设备上被移除……”。“去登录”和几秒后的自动跳转都等清理做完再跳（最多等 LEAVE_WAIT_MAX_MS），
//   清理没做完时按钮禁用，免得页面卸载把 IndexedDB 事务中止、留下“有会话、有库”
// • 本机已经没有会话（别的标签页正常退出了）：同上，提示“已退出登录”
// • 自己退出（“退出登录”和“移除本机”）：① 删本机那一行 devices ② 清本机库和缓存 ③ signOut local，不是 ok 就删本机会话。
//   会话放最后：中途被打断最坏是“有会话、没库”，下次打开能自愈。①③ 一共最多等 EXIT_TIMEOUT_MS（① 最多一半）；
//   超时照样删本机会话，提示“服务器上的这次登录暂时没能吊销”。超时以后请求才回来、本机会话又是退出前那个 user_id
//   （令牌刷新把旧会话写回）就再删一次。这些步骤在 platform/sign-out.ts，和登录页“退出并换账号”共用（K-signout-merge）
// • 本页自己处理“会话没了”时也会调 signOut：先 markSelfSignOutThisTab()（只打本页内存里的），会话层的 SIGNED_OUT 监听见到标记不再重复处理（K6-signedout）。
//   本页不另开 SIGNED_OUT 监听
import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDbAgain, dropSession, SIGN_OUT_TIMEOUT_MS, signOutThisDevice, withTimeout, wipeThisDevice } from '../../../platform/sign-out.ts';
import { markSelfSignOutThisTab } from '../../../platform/session.ts';
import { defaultExitDeps, type ExitDeps } from '../data/local.ts';
import type { SettingsApi } from '../data/settings-api.ts';

export type { ExitDeps } from '../data/local.ts';

/** 提示后自动跳回登录页的等待时间 */
export const REVOKED_REDIRECT_MS = 5000;
/** “退出这台设备”服务器部分（删本机行 + signOut）的总超时，同登录页 K4 */
export const EXIT_TIMEOUT_MS = SIGN_OUT_TIMEOUT_MS;
/**
 * 跳登录页前最多等清理多久（清理本身各步另有上限，这里再兜一层）。被移除那条路最坏：清库 3 + 按库名删库 3 + 缓存 2 + 再删一次库 3 = 11 秒，
 * 所以等 11 秒，第 ⑤ 步（会话删掉后再删一次库）也能做完
 */
export const LEAVE_WAIT_MAX_MS = 11000;

/** 退出前数没上传的最多等多久 */
export const COUNT_TIMEOUT_MS = 2500;

/** 离开前给用户看的那一句 */
export type ExitNotice = 'revoked' | 'signed_out' | 'offline_signout';

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

  const clearSession = useCallback(() => dropSession(exit), [exit]);

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
    clearSession();
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

  /** 会话没了：清空本机，清完马上删本机会话；signOut 放后台 */
  const onSessionLost = useCallback(
    (kind: 'revoked' | 'signed_out') => {
      if (exiting.current) return;
      exiting.current = true;
      // 下面后台调的 signOut 会引起本页的 SIGNED_OUT：先打标记，会话层不再按“被移除”重复处理（K6-signedout）。
      // 只打本页的（审查建议 4）：这是真的被移除，别的标签页收到转来的 SIGNED_OUT 仍要提示“被移除”
      markSelfSignOutThisTab();
      setNotice(kind);
      void track(
        (async () => {
          await wipeThisDevice(exit);
          clearSession();
          void api.dropLocalSession().catch(() => undefined);
          // 清库那几秒会话还在，别的标签页可能借旧会话 reload 重建了库：会话删掉以后再删一次（platform/sign-out.ts ⑤）
          await deleteDbAgain(exit);
        })(),
      );
    },
    [api, exit, track, clearSession],
  );

  const onRevoked = useCallback(() => onSessionLost('revoked'), [onSessionLost]);
  const onSignedOut = useCallback(() => onSessionLost('signed_out'), [onSessionLost]);

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
      // 顺序、超时、晚到处理都在 platform/sign-out.ts（和登录页共用）
      const run = signOutThisDevice({
        server: { deleteOwnDevice: () => api.deleteOwnDevice(currentDeviceId), signOut: () => api.dropLocalSession() },
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

  return { notice, cleaning, signingOut, onRevoked, onSignedOut, goToAuth, signOutHere, pendingCount };
}
