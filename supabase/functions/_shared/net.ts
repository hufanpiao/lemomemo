// 服务器函数的出站请求超时只在这里做（架构约定 10.1）；不变量：出站请求一律带超时，调用方自己的 signal 和超时谁先到算谁。
// 和 http.ts 分开：http.ts 只拼响应、不碰网络（ai-voice 等 core 的依赖链不准出现 fetch，tests/edge/voice-probe-guard.test.ts）。

/** 出站请求（Resend、Turnstile、R2）的默认超时 */
export const NET_TIMEOUT_MS = 8_000;

export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 带超时的 fetch：supabase-js 的 global.fetch、R2 客户端的 fetch 都用它 */
export function timedFetch(ms: number = NET_TIMEOUT_MS, base: FetchFn = (u, i) => fetch(u, i)): FetchFn {
  return (url, init = {}) => {
    const t = AbortSignal.timeout(ms);
    return base(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, t]) : t });
  };
}

/** 发到固定的外部服务（Resend、Turnstile）：带超时、不跟重定向 */
export function postOut(url: string, init: RequestInit, ms: number = NET_TIMEOUT_MS): Promise<Response> {
  return timedFetch(ms)(url, { ...init, method: 'POST', redirect: 'error' });
}
