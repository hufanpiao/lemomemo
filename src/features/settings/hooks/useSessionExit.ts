// 离开这台设备（架构 4.1、0.29 续第 98 条、0.38 第 7 条；K9 第二轮审查 N1、N2、L1）
// • 被移除 / 被退出 / 会话不认（session_revoked、unauthorized、401、刷新失败）：“发现”来自某个接口请求的回包，
//   回包带着那次请求用的会话的 session_id（settings-api 发请求前记下，接手清单 K6-sugg4 ①）。一发现就同步删本机会话——
//   只删那个 session_id 的（clearLocalSessionIf(sid)）：回包前别的标签页可能已用同一账号写进新会话，那个不删
//   （K6-sugg3 ① 的“同一同步段里删”管不到请求在路上的那几秒）。服务器上的会话已经没了，不用等 signOut。
//   signOut local 紧接着放后台、不等它；本机会话已经是别人的（上面没删掉）时不调，免得它把那个新会话退掉。
//   再清本机库和 Cache Storage，清完、回登录页前只在本机会话还是那个 sid 时再删——清库那几秒里别的标签页刚登录的新会话不删。
//   signOut 不能放到清库之后：supabase-js 的 signOut 自己读本机会话、最后自己删会话键（含 `-user` 等），放在后面会把那个新会话当成本页的退掉。
//   放在前面时本机会话已删，它读到没有会话就不发吊销请求，但不是“几毫秒就做完”（K6-sugg4 ⑤）：客户端还没建好时要先加载 supabase-js 分包
//   （慢网几秒；离线加载失败就走兜底删），建好了也要先等它初始化完（initializePromise，里面可能在刷新令牌）、再排 auth-js 的锁（auth-js GoTrueClient.signOut）；最后它照样无条件删一次会话键，
//   这段时间里别的标签页写进来的新会话：K6-signout-lib 起后台这次 signOut 也挂 defaultGuardRemoval(sid)，会话键已不是 sid 就不删；
//   settings-api 紧贴 signOut 前也会再读一次本机会话，换了就不调 signOut
//   界面提示“这台设备已在别的设备上被移除……”。“去登录”和几秒后的自动跳转都等清理做完再跳（最多等 LEAVE_WAIT_MAX_MS），
//   清理没做完时按钮禁用，免得页面卸载把 IndexedDB 事务中止、留下“有会话、有库”
// • 本机已经没有会话（别的标签页正常退出了）：同上，提示“已退出登录”
// • 自己退出（“退出登录”和“移除本机”）：① 删本机那一行 devices ② 清本机库和缓存 ③ signOut local，不是 ok 就删本机会话。
//   会话放最后：中途被打断最坏是“有会话、没库”，下次打开能自愈。①③ 一共最多等 EXIT_TIMEOUT_MS（① 最多一半）；
//   超时照样删本机会话，提示“服务器上的这次登录暂时没能吊销”。超时以后请求才回来、本机会话又是退出前那个 user_id
//   （令牌刷新把旧会话写回）就再删一次。这些步骤在 platform/sign-out.ts，和登录页“退出并换账号”共用（K-signout-merge）
// • 本页自己处理“会话没了”时也会调 signOut：先 markSelfSignOutThisTab()（只打本页内存里的），会话层的 SIGNED_OUT 监听见到标记不再重复处理（K6-signedout）。
//   本页不另开 SIGNED_OUT 监听
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultGuardRemoval, deleteDbAgain, dropSession, sessionIdOf, SIGN_OUT_TIMEOUT_MS, signOutThisDevice, withTimeout, wipeThisDevice,
} from '../../../platform/sign-out.ts';
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
      dropSession(exit, sid);
      // 本机会话已经是别的会话（回包前别的标签页写进来的，上面没删）：不调 signOut，免得把它退掉（见文件头）
      const now = sessionIdOf(exit);
      if (now === null || now === sid) {
        // 后台的 signOut 也挂删键保护（K6-signout-lib 复审建议）：它最后删会话键时，本机若已是别的标签页的新会话就不删
        const release = defaultGuardRemoval(sid);
        void api.dropLocalSession(sid).catch(() => undefined).finally(release);
      }
      setNotice(kind);
      void track(
        (async () => {
          await wipeThisDevice(exit);
          clearSession();   // 旧会话被晚到的令牌刷新写回时再删
          // 别的标签页可能在本页删会话之前借旧会话 reload 重建了库：会话删掉以后再删一次（platform/sign-out.ts ⑤）
          await deleteDbAgain(exit);
        })(),
      );
    },
    [api, exit, track, clearSession],
  );

  const onRevoked = useCallback((sid: string | null) => onSessionLost('revoked', sid), [onSessionLost]);
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
