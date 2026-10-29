// 已登录的人打开 /app/auth/（安全审查 9、架构 0.38 第 35 条、4.1）
// - 判断“已登录”：platform/session.ts 的 readSessionUserId（只读 localStorage 里 supabase-js 的会话，不加载 supabase-js、不联网）
// - 已登录：显示“当前已登录，要换账号请先退出”，两个按钮：“退出并换账号”“回到 App”
// - “退出并换账号”按 4.1 完整退出，依次：① 删本会话那一行 devices ② signOut({scope: 'local'})，只吊销本会话
//   ③ 清本机库和运行时缓存（data/local-exit.ts）；做完才显示登录表单。
//   ①② 不是 ok（断网、令牌过期、客户端拿不到）时先兜底清本机会话（clearLocalSession），再照样清本机、往下走
// - ①② 套 SIGN_OUT_TIMEOUT_MS 的总超时（K4 追加项复审必改）：appFetch 没有超时，令牌过期时 supabase-js 会先刷新、
//   出错再退避重试（约 30 秒），网络卡住时请求一直不返回；超时按“不是 ok”处理，照样兜底、清本机、出登录表单。
//   超时以后请求才回来：本机会话还是退出前那个 user_id（旧会话被刷新写回）就再清一次，别的账号或没有会话不动
// - 这条主路径里旧会话还在，所以删得掉 devices 行（以后还有推送订阅）；别的标签页换了账号的兜底在主 App（K6）
import { useCallback, useMemo, useState } from 'react';
import { readSessionUserId } from '../../../platform/session.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createAuthApi, type Result } from '../data/auth-api.ts';
import { defaultLocalExitDeps, wipeLocal } from '../data/local-exit.ts';
import type { AuthFlowDeps } from './useAuthFlow.ts';

export type SessionState = 'signed-in' | 'exiting' | 'none';

/** 服务器退出（删 devices 行 + signOut）最多等多久 */
export const SIGN_OUT_TIMEOUT_MS = 8000;

/**
 * 到点还没返回就当作失败。原来的请求不取消：它晚到时调 onLate（只在已经超时的情况下调一次）。
 * 抛异常（同步或异步）都按“不是 ok”处理
 */
function withTimeout(run: () => Promise<Result>, ms: number, onLate: () => void): Promise<Result> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const req = Promise.resolve()
    .then(run)
    .catch((): Result => ({ ok: false, error: 'unknown' }));
  void req.finally(() => {
    if (timedOut) onLate();
  });
  const timeout = new Promise<Result>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, error: 'offline' });
    }, ms);
  });
  return Promise.race([req, timeout]).finally(() => clearTimeout(timer));
}

export function useSessionGate(deps: AuthFlowDeps = {}) {
  const api = useMemo(() => deps.api ?? createAuthApi(getSupabase), [deps.api]);
  const backToApp = deps.onDone ?? (() => location.replace('/app/'));
  const localExit = deps.localExit ?? defaultLocalExitDeps;
  const readUserId = deps.readUserId ?? readSessionUserId;
  const [state, setState] = useState<SessionState>(() => (readUserId() ? 'signed-in' : 'none'));

  const clearSession = useCallback(() => {
    try {
      localExit.clearLocalSession();
    } catch {
      // 兜底也失败（存储不可用）：本来也存不下会话
    }
  }, [localExit]);

  const switchAccount = useCallback(async () => {
    setState('exiting');
    const before = readUserId();
    // 晚到处理（K4 超时复审）：令牌过期时 supabase-js 可能超过总超时才刷新成功，把旧会话写回 localStorage（旧会话“复活”）。
    // 超时以后请求才回来：本机会话还是退出前那个 user_id 就再清一次；别的账号（已经在这页重新登录）或已经没有会话就不动
    const onLate = () => {
      const now = readUserId();
      if (before !== null && now === before) clearSession();
    };
    const r = await withTimeout(() => api.signOutHere(), deps.signOutTimeoutMs ?? SIGN_OUT_TIMEOUT_MS, onLate);
    if (!r.ok) clearSession();
    await wipeLocal(localExit);
    setState('none');
  }, [api, localExit, readUserId, clearSession, deps.signOutTimeoutMs]);

  return { state, backToApp, switchAccount };
}
