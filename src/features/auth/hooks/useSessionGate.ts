// 已登录的人打开 /app/auth/（安全审查 9、架构 0.38 第 35 条、4.1）
// - 判断“已登录”：platform/session.ts 的 readSessionUserId（只读 localStorage 里 supabase-js 的会话，不加载 supabase-js、不联网）
// - 已登录：显示“当前已登录 <邮箱>，要换账号请先退出”（4.1 原文；邮箱读 readSessionEmail，读不到就不带邮箱），两个按钮：“退出并换账号”“回到 App”
// - “退出并换账号”按 4.1 完整退出，走 platform/sign-out.ts 的 signOutThisDevice（和设置页同一份，K-signout-merge；编号同那边）：
//   ②③ 清本机库（登录页不跑 boot：按库名删 planner-v4）和运行时缓存 → ④ api.signOutHere()：先删本会话那一行 devices（即 ①，合在这一步里，
//   和 signOut 共用 SIGN_OUT_TIMEOUT_MS）再 signOut({scope: 'local'})，只吊销本会话；不是 ok（断网、令牌过期、客户端拿不到）或超时就兜底
//   清本机会话（只删退出前那一个，K6-sugg3 ①）→ ⑤ 会话删掉以后再删一次库。做完才显示登录表单；最坏约 16 秒。
//   会话放在 ④：中途被打断最坏是“有会话、没库”，下次打开能自愈
//   ④ 拿到 signOutThisDevice 一开头记下的旧会话（prior）：删 devices 行用它的 sid；auth-api 在 signOut 之前再读一次本机会话，
//   已换成别的标签页的新会话就改用旧令牌直接 logout，不让 supabase-js 把新会话退掉（K6-signout-lib）
// - 超时以后请求才回来：本机会话还是退出前那个 user_id（旧会话被刷新写回）就再清一次，别的账号或没有会话不动
// - 这条主路径里旧会话还在，所以删得掉 devices 行（以后还有推送订阅）；别的标签页换了账号的兜底在主 App（K6）
// - 服务器没退成（serverDone = false：断网、超时、出错）：本机照样清空，登录表单上方多一句“服务器上的这次登录暂时没能吊销”
//   （和设置页 settings.offlineOut 同一个意思；sign-out.ts 约定调用方提示）
// - 别的标签页换了账号或退出（K6-auth-switch 审查建议）：
//   ① 挂 onSessionStorageChange，会话一变就重读 user_id 和邮箱，提示跟着换（没有会话了就出登录表单）；退出进行中不理会
//   ② 点“退出并换账号”时再读一次 user_id，和提示里显示的那个比：不一样就只刷新提示、多一句“账号刚在别的页面换过”，这次不退出——
//      免得用户看着 A 的邮箱、退掉的却是 B（storage 事件没赶上的窗口也兜住）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onSessionStorageChange, readSessionEmail, readSessionUserId } from '../../../platform/session.ts';
import { defaultExitSteps, SIGN_OUT_TIMEOUT_MS, signOutThisDevice } from '../../../platform/sign-out.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createAuthApi } from '../data/auth-api.ts';
import type { AuthFlowDeps } from './useAuthFlow.ts';

export { SIGN_OUT_TIMEOUT_MS } from '../../../platform/sign-out.ts';

export type SessionState = 'signed-in' | 'exiting' | 'none';

export function useSessionGate(deps: AuthFlowDeps = {}) {
  const api = useMemo(() => deps.api ?? createAuthApi(getSupabase), [deps.api]);
  const backToApp = deps.onDone ?? (() => location.replace('/app/'));
  const localExit = deps.localExit ?? defaultExitSteps;
  const readUserId = deps.readUserId ?? readSessionUserId;
  const readEmail = deps.readEmail ?? readSessionEmail;
  const watchSession = deps.watchSession ?? ((fn: () => void) => onSessionStorageChange(() => fn()));
  /** 提示里显示的是哪个账号（user_id 和邮箱一起换） */
  const [shown, setShown] = useState<{ userId: string | null; email: string | null }>(() => {
    const userId = readUserId();
    return { userId, email: userId ? readEmail() : null };
  });
  const [state, setState] = useState<SessionState>(() => (shown.userId ? 'signed-in' : 'none'));
  /** 这次“退出并换账号”服务器没退成（只有本页刚退出过才可能为 true） */
  const [serverPending, setServerPending] = useState(false);
  /** 点按钮时发现账号已在别的页面换过：提示刷新了，这次没退出 */
  const [changed, setChanged] = useState(false);
  const exiting = useRef(false);

  /** 重读本机会话，提示跟着换；返回现在的 user_id */
  const refresh = useCallback((): string | null => {
    const userId = readUserId();
    setShown({ userId, email: userId ? readEmail() : null });
    setState(userId ? 'signed-in' : 'none');
    return userId;
  }, [readUserId, readEmail]);

  const shownRef = useRef(shown);
  shownRef.current = shown;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const watchRef = useRef(watchSession);
  useEffect(
    () =>
      watchRef.current(() => {
        if (exiting.current) return;
        const before = shownRef.current.userId;
        if (refreshRef.current() !== before) {
          setChanged(false);
          setServerPending(false);
        }
      }),
    [],
  );

  const switchAccount = useCallback(async () => {
    const now = readUserId();
    if (now !== shownRef.current.userId) {
      // 显示的是 A、本机会话已是 B（或已退出）：只刷新提示，不退出
      refresh();
      setChanged(now !== null);
      return;
    }
    exiting.current = true;
    const exited = now;
    setChanged(false);
    setState('exiting');
    const r = await signOutThisDevice({
      // prior = 退出一开头记下的旧会话（sid、令牌、④ 剩下的预算）：删行用它的 sid，紧贴 signOut 前判断会话换没换（K6-signout-lib）
      server: { signOut: async (prior) => ({ serverDone: (await api.signOutHere(prior)).ok }) },
      steps: localExit,
      readUserId,
      timeoutMs: deps.signOutTimeoutMs ?? SIGN_OUT_TIMEOUT_MS,
    });
    setServerPending(!r.serverDone);
    exiting.current = false;
    // 退出完成后重读一次会话（复核建议）：退出那几秒里别的标签页登录了 B，就显示“当前已登录 B”。
    // 读到的还是刚退掉的那个账号（只会是超时后旧会话被刷新写回，sign-out.ts 的晚到处理会再删掉它）：照旧出登录表单，不显示成“还登录着”
    if (refresh() === exited) {
      setShown({ userId: null, email: null });
      setState('none');
    }
  }, [api, localExit, readUserId, refresh, deps.signOutTimeoutMs]);

  return { state, email: shown.email, changed, serverPending, backToApp, switchAccount };
}
