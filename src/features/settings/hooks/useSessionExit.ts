// 设置页离开这台设备（架构 4.1、4.1a）：会话不认、本机已没有会话、本人退出三种；清理步骤在 platform/sign-out.ts
// 不变量：发现会话不认就同步删那次请求用的 sid（别的标签页的新会话不删）；后台 signOut local 放在清库之前；跳登录页等清理做完（最多 LEAVE_WAIT_MAX_MS）
// 不变量：onRevoked 先 markHere（设闸、写记号）再查 session_fate，没确认被吊销只关库、不清、不写第二次；写不了记号才按被移除清库
// 不变量：本页自己调 signOut 前先 markSelfSignOutThisTab，会话层的 SIGNED_OUT 不再重复处理；本页不另开 SIGNED_OUT 监听
// 详细理由见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultGuardRemoval, deleteDbAgain, dropSession, sessionIdOf, SIGN_OUT_TIMEOUT_MS, signOutThisDevice, withTimeout, wipeThisDevice,
} from '../../../platform/sign-out.ts';
import { decideExit } from '../../../core/device-exit.ts';
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
  /**
   * 本页那个会话的 session_id：自己退出时是退出前读的，会话没了时是被拒那次请求用的（K6-sugg3 ①、K6-sugg4 ①）。
   * 两条路都先记下再走到 leave，没记下（null）时 clearLocalSessionIf(null) 只在本机没有会话时删，等于不删别人的
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

  /** 会话没了（sid：被拒那次请求用的会话）：只删那个会话，清空本机，清完再删一次；signOut 放后台 */
  const onSessionLost = useCallback(
    (kind: 'revoked' | 'signed_out', sid: string | null) => {
      if (exiting.current) return;
      exiting.current = true;
      // 下面后台调的 signOut 会引起本页的 SIGNED_OUT：先打标记，会话层不再按“被移除”重复处理（K6-signedout）。
      // 只打本页的（审查建议 4）：这是真的被移除，别的标签页收到转来的 SIGNED_OUT 仍要提示“被移除”。
      // 标记记的是被拒的那个会话（K6-sugg4 ①），不是回包时本机的会话
      markSelfSignOutThisTab(Date.now(), sid);
      deadSid.current = sid;
      void dropSession(exit, sid);   // 不抛错；删没删成由 session-store 的删除状态兜着（A-1）
      // 本机会话已经是别的会话（回包前别的标签页写进来的，上面没删）：不调 signOut，免得把它退掉（见文件头）
      const now = sessionIdOf(exit);
      if (now === null || now === sid) {
        // 后台的 signOut 也挂删键保护（K6-signout-lib 复审建议）：它最后删会话键时，本机若已是别的标签页的新会话就不删。
        // 这里故意不传 prior（旧令牌）（K6-signout-lib 复审建议 ③）：被移除、会话失效说明服务器上这次登录已经作废，用旧令牌再 logout
        // 只会回 401，没有要吊销的；会话被换的情形上面已经不调 signOut，dropLocal 里的 logoutReplaced 拿不到令牌也只是算退成、不发请求
        const release = defaultGuardRemoval(sid);
        void api.dropLocalSession(sid).catch(() => undefined).finally(release);
      }
      setNotice(kind);
      void track(
        (async () => {
          await wipeThisDevice(exit);
          void clearSession();   // 旧会话被晚到的令牌刷新写回时再删
          // 别的标签页可能在本页删会话之前借旧会话 reload 重建了库：会话删掉以后再删一次（platform/sign-out.ts ⑤）
          await deleteDbAgain(exit);
        })(),
      );
    },
    [api, exit, track, clearSession],
  );

  const onRevoked = useCallback(
    (sid: string | null) => {
      const expire = exit.expireHere;
      if (!expire || !exit.resolveAuthLoss) return onSessionLost('revoked', sid);
      if (exiting.current) return;
      exiting.current = true;   // 定结局那几秒里再来的信号不再处理
      // 查 session_fate 之前先设闸、写记号（和别的出口一样先 markExpired，独立验证建议 3）：查的那几秒里不再往外发；写不了记号直接按被移除清库
      const marked = exit.markHere?.(sid);
      if (marked === false) {
        exiting.current = false;
        return onSessionLost('revoked', sid);
      }
      const userId = exit.lostUserId?.() ?? null;
      void exit
        .resolveAuthLoss({ path: 'settings', code: 'session_revoked', sessionId: sid, userId })
        .catch(() => 'expired' as const)
        .then((r) => {
          // 结局按 core/device-exit.ts 的 decideExit：没确认被移除只退出（记号已写好就只关库）；写不了记号退回清库
          if (decideExit({ reason: 'removed', fate: r }).act === 'logout' && expire(sid, marked === true)) {
            void dropSession(exit, sid);
            exit.goToAuthExpired?.(sid);
            return;
          }
          exiting.current = false;
          onSessionLost('revoked', sid);
        });
    },
    [exit, onSessionLost],
  );
  const onSignedOut = useCallback((sid: string | null) => onSessionLost('signed_out', sid), [onSessionLost]);

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

  return { notice, cleaning, signingOut, onRevoked, onSignedOut, goToAuth, signOutHere, pendingCount };
}
