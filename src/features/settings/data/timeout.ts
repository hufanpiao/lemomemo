// 设置页的超时（K9 第二轮审查 N2）：appFetch 没有超时，网络卡住、令牌过期时 supabase-js 会先刷新再退避重试，
// 请求可能几十秒不返回；界面不能一直卡着。做法同登录页（features/auth/hooks/useSessionGate.ts，K4），这里不 import 它

/** 读列表、移除、退出其他设备、改语言，以及“退出这台设备”整个服务器部分最多等多久 */
export const API_TIMEOUT_MS = 8000;

/**
 * 到点还没返回就用 fallback() 的值；run 抛错（同步或异步）也用 fallback()。fallback 只给值，不要有副作用。
 * 原来的请求不取消：它在超时以后才回来时调一次 onLate
 */
export function withTimeout<T>(run: () => Promise<T>, ms: number, fallback: () => T, onLate?: () => void): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const req = Promise.resolve().then(run);
  const late = (): void => {
    if (timedOut) onLate?.();
  };
  req.then(late, late);
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback());
    }, ms);
  });
  return Promise.race([req.catch(() => fallback()), timeout]).finally(() => clearTimeout(timer));
}
