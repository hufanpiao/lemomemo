// 登录页离开时去哪、exe 里怎么注册（架构 5.10）：
// • leaveAuthPage：网页版跳回 /app/；exe 的登录小窗口不能导航到主页面（policy.rs），调 auth_done，由 Rust 通知 main 重读会话、拉到前台、关掉小窗口。
//   auth_done 失败时小窗口不会关：记下“没交接成”，界面（AuthDoneRetry）据此提示一句、给“重试”，重试走 retryAuthDone
// • openDesktopSignup：exe 里不做注册，调 auth_open_signup 用系统浏览器打开注册页；地址写死在 Rust（env.rs），这里不传任何载荷
import { createSignal } from '../../shared/core/signal.ts';
import { tauriInvoke, type Invoke } from './desktop-invoke.ts';
import { rlog } from './run-log-api.ts';

let doneFailed = false;
const changed = createSignal();
const setDoneFailed = (v: boolean): void => {
  if (doneFailed === v) return;
  doneFailed = v;
  changed.emit();
};

/** auth_done 最近一次是不是失败了（登录小窗口还开着、main 没收到） */
export const authDoneFailed = (): boolean => doneFailed;

/** 订阅 authDoneFailed 的变化（给 useSyncExternalStore）；返回取消订阅 */
export const subscribeAuthDone = changed.subscribe;

/** 调一次 auth_done：成功 true（Rust 会关掉小窗口），失败 false 并记下 */
export async function retryAuthDone(invoke: Invoke | undefined = tauriInvoke()): Promise<boolean> {
  if (!invoke) return false;
  try {
    await invoke('auth_done');
    setDoneFailed(false);
    return true;
  } catch {
    rlog('auth done failed');
    setDoneFailed(true);
    return false;
  }
}

export function leaveAuthPage(invoke: Invoke | undefined = tauriInvoke(), go: (url: string) => void = (u) => location.replace(u)): void {
  if (!invoke) {
    go('/app/');
    return;
  }
  void retryAuthDone(invoke);
}

/** 打开成功 true；失败 false（界面提示一句，按钮还在，可以再点） */
export async function openDesktopSignup(invoke: Invoke | undefined = tauriInvoke()): Promise<boolean> {
  if (!invoke) return false;
  try {
    await invoke('auth_open_signup');
    return true;
  } catch {
    rlog('auth signup open failed');
    return false;
  }
}
