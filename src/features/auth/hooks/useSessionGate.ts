// 已登录的人打开 /app/auth/（安全审查 9、架构 0.38 第 35 条、4.1）
// - 判断“已登录”：platform/session.ts 的 readSessionUserId（只读 localStorage 里 supabase-js 的会话，不加载 supabase-js、不联网）
// - 已登录：显示“当前已登录，要换账号请先退出”，两个按钮：“退出并换账号”“回到 App”
// - “退出并换账号”按 4.1 完整退出，走 platform/sign-out.ts 的 signOutThisDevice（和设置页同一份，K-signout-merge；编号同那边）：
//   ②③ 清本机库（登录页不跑 boot：按库名删 planner-v4）和运行时缓存 → ④ api.signOutHere()：先删本会话那一行 devices（即 ①，合在这一步里，
//   和 signOut 共用 SIGN_OUT_TIMEOUT_MS）再 signOut({scope: 'local'})，只吊销本会话；不是 ok（断网、令牌过期、客户端拿不到）或超时就兜底
//   清本机会话（clearLocalSession）→ ⑤ 会话删掉以后再删一次库。做完才显示登录表单；最坏约 16 秒。
//   会话放在 ④：中途被打断最坏是“有会话、没库”，下次打开能自愈
// - 超时以后请求才回来：本机会话还是退出前那个 user_id（旧会话被刷新写回）就再清一次，别的账号或没有会话不动
// - 这条主路径里旧会话还在，所以删得掉 devices 行（以后还有推送订阅）；别的标签页换了账号的兜底在主 App（K6）
import { useCallback, useMemo, useState } from 'react';
import { readSessionUserId } from '../../../platform/session.ts';
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
  const [state, setState] = useState<SessionState>(() => (readUserId() ? 'signed-in' : 'none'));

  const switchAccount = useCallback(async () => {
    setState('exiting');
    await signOutThisDevice({
      server: { signOut: async () => ({ serverDone: (await api.signOutHere()).ok }) },
      steps: localExit,
      readUserId,
      timeoutMs: deps.signOutTimeoutMs ?? SIGN_OUT_TIMEOUT_MS,
    });
    setState('none');
  }, [api, localExit, readUserId, deps.signOutTimeoutMs]);

  return { state, backToApp, switchAccount };
}
