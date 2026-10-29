// 登录后的冷静期探测和恢复页（R-256 ③、R-258、架构 0.29 续第 131 条④、第 134 条、第 6 节“account 的错误码”；TC-B1-100、103）
// 什么时候探测：验证码通过后、跳进 /app/ 之前（useAuthFlow 的 probe 调 check('login')）；本机已有会话时 SessionCheck 调 check('session')
// check(mode) 的结果：
//   active → true，照常进 App
//   unknown（try_later、断网、超时、会话失效、回包认不出；R-258）：
//     login（验证码刚通过）→ false，原地出“暂时无法确认账号状态”，“重试”重新探测、“仍然进入”照旧进 App（之后靠同步收到
//       account_pending_deletion 兜底）；不清本机
//     session（本机已有会话）→ true，不挡：常在断网时打开，要保证离线能用
//   pending_deletion → false，原地显示恢复页
//   disabled → false，退出本会话、清本机（auth.exit.disabled 说了“数据已清除”），做完才显示那句和“回到登录”。
//     后端审查 10-30：status 回 200 {ok:true, status:'disabled'} 绝不当成登录成功；停用 + 会话已吊销时也回 disabled，不另分
// 恢复页两个按钮：
//   “恢复账号”→ restore：成功（或 not_pending）先按库名删本机库（0.29 续第 131 条④ 整表重拉；登录页不能引 core，
//     用 platform/sign-out.ts 的 deleteLocalDb，core/cache.ts 的 deleteCacheDb 也是它）再 onRestored（进 /app/）；
//     reauth_required → 退出本会话、回填邮箱那一步提示重新收码；account_disabled → 停用页；其余按错误码表提示
//   “保持注销并退出”→ 退出本会话：platform/sign-out.ts 的 signOutThisDevice，服务器一半只 signOut({scope:'local'})，不删 devices 行；
//     做完再 clearLocalSessionIf(探测时记下的 sid)。本机库和运行时缓存一并清掉
// 多标签页（审查必改 2）：check 时把本机会话的 sid、user_id、access token 记进 ref（只在内存里，不写存储、不记录）。
//   退出、恢复前先比现在的 sid、user_id：变了（别的标签页登录了别人）就不调 supabase-js 的 signOut、不删库、不调 restore——
//   要退出的用记下的旧令牌经 platform/sign-out.ts 的 logoutWithToken 吊销那一次登录；然后 onReplaced 让登录页重走 SessionCheck。
//   例外（复审建议 2）：现在读到的 sid 是 null（A 已在别处退出，本机已空）不算换了人：退出时照常清本机库和缓存，再用旧令牌 /logout，
//   照常显示退出后的提示（kept、reauth）；只有 sid 换成了别的值才走“不删库、重走 SessionCheck”
// 记下的 snap 用完就清（复审建议 3）：check 放行、恢复成功跳转前、退出后
import { useCallback, useMemo, useRef, useState } from 'react';
import { clearLogQueue } from '../../../platform/log-store.ts';
import { readSessionAccessToken, readSessionUserId } from '../../../platform/session.ts';
import {
  defaultExitSteps,
  dropSession,
  logoutWithToken,
  SIGN_OUT_TIMEOUT_MS,
  sessionIdOf,
  signOutThisDevice,
  wipeThisDevice,
} from '../../../platform/sign-out.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createAccountGateApi, purgeWhen, type PurgeWhen, type RestoreErr } from '../data/account-gate.ts';
import type { AuthFlowDeps } from './useAuthFlow.ts';

/** none：没有要挡的；checking：探测中；pending：恢复页；disabled：停用页；unsure：验证码刚通过、探测不出；exited：本会话已退出、回登录表单 */
export type GateView = 'none' | 'checking' | 'pending' | 'disabled' | 'unsure' | 'exited';
/** login：验证码刚通过；session：本机已有会话（SessionCheck） */
export type ProbeMode = 'login' | 'session';
/** 回到登录表单时提示什么：reauth 要重新收码再恢复；kept 选了保持注销 */
export type GateExit = 'reauth' | 'kept';
/** 恢复页上显示的错误（其余几种另有去处：reauth_required、account_disabled、not_pending） */
export type GateErr = Exclude<RestoreErr, 'reauth_required' | 'account_disabled' | 'not_pending'>;

/** 探测时的本机会话（只在内存里） */
interface Snap {
  sid: string | null;
  userId: string | null;
  token: string | null;
}

function safe(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * 本机会话和探测时比：same 没变；gone 本机已没有会话（探测时有；sid 和 user_id 都读不到）；other 换成了别的会话。
 * sid 读不到但 user_id 还读得到（令牌格式怪、读到一半）按 other：不敢当成“本机已空”去清库（复审小建议 1）
 */
function compareSnap(s: Snap | null, sid: string | null, userId: string | null): 'same' | 'gone' | 'other' {
  if (s === null || (sid === s.sid && userId === s.userId)) return 'same';
  return sid === null && userId === null && s.sid !== null ? 'gone' : 'other';
}

/** 按钮动作：同一时间只跑一个，跑的时候 busy */
function useGuarded(setBusy: (b: boolean) => void) {
  const running = useRef(false);
  return useCallback(
    async (fn: () => Promise<void>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      try {
        await fn();
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [setBusy],
  );
}

/** onReplaced：发现本机会话已被别的标签页换掉时调（登录页据此重走 SessionCheck） */
export function useAccountGate(deps: AuthFlowDeps = {}, onReplaced?: () => void) {
  const account = useMemo(() => deps.account ?? createAccountGateApi(getSupabase), [deps.account]);
  const steps = deps.localExit ?? defaultExitSteps;
  const readUserId = deps.readUserId ?? readSessionUserId;
  const readToken = deps.readToken ?? readSessionAccessToken;
  const logout = deps.logoutWithToken ?? logoutWithToken;
  const timeoutMs = deps.signOutTimeoutMs ?? SIGN_OUT_TIMEOUT_MS;
  const [view, setView] = useState<GateView>('none');
  const [purgeAfter, setPurgeAfter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GateErr | null>(null);
  const [exit, setExit] = useState<GateExit | null>(null);
  const guarded = useGuarded(setBusy);
  const snap = useRef<Snap | null>(null);
  const onReplacedRef = useRef(onReplaced);
  onReplacedRef.current = onReplaced;

  const compare = useCallback(() => compareSnap(snap.current, sessionIdOf(steps), safe(readUserId)), [steps, readUserId]);
  const replaced = useCallback(() => compare() !== 'same', [compare]);

  /** 会话已换：只刷新界面，重走 SessionCheck；logoutOld = 用记下的旧令牌吊销那一次登录（退出时） */
  const reload = useCallback(
    async (logoutOld: boolean) => {
      const token = snap.current?.token ?? null;
      snap.current = null;
      if (logoutOld && token) await logout(token, timeoutMs);
      setView('none');
      onReplacedRef.current?.();
    },
    [logout, timeoutMs],
  );

  /** 退出本会话（不删 devices 行）；会话已被换成别人的时不退、返回 false（已交给 reload） */
  const exitHere = useCallback(async (): Promise<boolean> => {
    const c = compare();
    if (c === 'other') {
      await reload(true);
      return false;
    }
    if (c === 'gone') {
      // 本机已空：照常清本机库、缓存和 A 没传完的日志队列（同 signOutThisDevice 的 ②③），再用旧令牌吊销 A 的那一次登录
      const token = snap.current?.token ?? null;
      const userId = snap.current?.userId ?? null;
      snap.current = null;
      await wipeThisDevice(steps);
      clearLogQueue(userId);
      if (token) await logout(token, timeoutMs);
      return true;
    }
    const sid = snap.current ? snap.current.sid : sessionIdOf(steps);
    await signOutThisDevice({
      server: { signOut: async (prior) => ({ serverDone: await account.signOutLocal(prior) }) },
      steps,
      readUserId: () => safe(readUserId),
      readToken: () => safe(readToken),
      logoutWithToken: logout,
      timeoutMs,
    });
    dropSession(steps, sid);
    snap.current = null;
    return true;
  }, [compare, reload, account, steps, readUserId, readToken, logout, timeoutMs]);

  /** 停用：先退出、清本机，做完（busy 落下）才显示“已停用”那句 */
  const toDisabled = useCallback(async () => {
    setView('disabled');
    setBusy(true);
    try {
      await exitHere();
    } finally {
      setBusy(false);
    }
  }, [exitHere]);

  /**
   * 探测；true = 照常进 App。quiet = 不切到 checking（“重试”时用：unsure 面板留着，免得露出验证码框被再提交一次，复审建议 1）。
   * disabled 时等退出、清本机做完才返回（复审必改：不能让外层先把 busy 落下、提前显示“数据已清除”）
   */
  const check = useCallback(
    async (mode: ProbeMode, quiet = false): Promise<boolean> => {
      snap.current = { sid: sessionIdOf(steps), userId: safe(readUserId), token: safe(readToken) };
      if (!quiet) setView('checking');
      setError(null);
      setExit(null);
      const s = await account.status();
      if (s.kind === 'pending_deletion') {
        setPurgeAfter(s.purgeAfter);
        setView('pending');
        return false;
      }
      if (s.kind === 'disabled') {
        await toDisabled();
        return false;
      }
      if (s.kind === 'unknown' && mode === 'login') {
        setView('unsure');
        return false;
      }
      snap.current = null;
      setView('none');
      return true;
    },
    [account, steps, readUserId, readToken, toDisabled],
  );

  /** “暂时无法确认”页的“重试”：再探测一次，这次能进就进 */
  const retry = useCallback(
    (onEnter: () => void) =>
      guarded(async () => {
        if (await check('login', true)) onEnter();
      }),
    [guarded, check],
  );

  const restore = useCallback(
    (onRestored: () => void) =>
      guarded(async () => {
        setError(null);
        // 别的标签页已换了账号：不调 restore，重走一遍探测（按现在的会话）
        if (replaced()) return void (await reload(false));
        const r = await account.restore();
        if (r.ok || r.error === 'not_pending') {
          // 恢复期间别的标签页换了账号：不删别人的库
          if (replaced()) return void (await reload(false));
          try {
            await steps.deleteDb();
          } catch {
            // 删不掉：主 App 冷启动按 user_id 核对，照样能整表重拉
          }
          snap.current = null;
          setView('none');
          onRestored();
          return;
        }
        if (r.error === 'reauth_required') {
          if (await exitHere()) {
            setExit('reauth');
            setView('exited');
          }
          return;
        }
        if (r.error === 'account_disabled') return void (await toDisabled());
        setError(r.error);
      }),
    [guarded, account, steps, replaced, reload, exitHere, toDisabled],
  );

  const keep = useCallback(
    () =>
      guarded(async () => {
        if (await exitHere()) {
          setExit('kept');
          setView('exited');
        }
      }),
    [guarded, exitHere],
  );

  /** “暂时无法确认”页的“仍然进入”：照旧进 App（之后靠同步收到 account_pending_deletion 兜底） */
  const enter = useCallback((onEnter: () => void) => {
    setView('none');
    onEnter();
  }, []);

  /** 停用页的“回到登录”：本会话已退出，回登录表单 */
  const backToLogin = useCallback(() => {
    setExit(null);
    setView('exited');
  }, []);

  /** 恢复页上的删除时刻（本机时区）；purge_after 为 null 时为 null */
  const when: PurgeWhen | null = useMemo(() => purgeWhen(purgeAfter), [purgeAfter]);

  return { view, purgeAfter, when, busy, error, exit, check, retry, enter, restore, keep, backToLogin };
}

export type AccountGate = ReturnType<typeof useAccountGate>;
