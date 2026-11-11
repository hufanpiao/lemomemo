// 服务器函数出站 HTTP 请求的超时只在这里做（架构约定 10.1）：所有函数 createClient 的 global.fetch（tests/functions/shared-net.test.ts 逐处核对）、
//   R2、Resend、Turnstile、Gemini、Web Push 都经 timedFetch。store-timeout.ts、auth.ts 的按调用计时是在这之上另加的更短一层。
// 不经这里的只有 shared/objstore 自带的超时（和 Workers 共用、不能引本目录；account-purge 外面再套一层）。
// 底层 fetch 由调用方传进来，本文件不碰全局：ai-voice 的依赖链经 gemini.ts 引到这里，链上不准出现全局网络（tests/edge/voice-probe-guard.test.ts）。
// 用 setTimeout 计时而不是 AbortSignal.timeout：测试的假计时器管得到。到点前不清计时器——读响应正文也算在超时里，到点中止已经读完的请求不起作用。

/** 默认超时（Resend、Turnstile、R2） */
export const NET_TIMEOUT_MS = 8_000;

type Fetch<U> = (url: U, init: RequestInit) => Promise<Response>;

/** 给底层请求函数加超时：到点以 TimeoutError 中止；调用方自己的 signal 和超时谁先到算谁 */
export function timedFetch<U>(base: Fetch<U>, ms: number = NET_TIMEOUT_MS): (url: U, init?: RequestInit) => Promise<Response> {
  return (url, init = {}) => {
    const t = new AbortController();
    setTimeout(() => t.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
    return base(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, t.signal]) : t.signal });
  };
}

/** 发到固定的外部服务（Resend、Turnstile）：一律 POST、带超时、不跟重定向 */
export function postOut(base: Fetch<string>, url: string, init: RequestInit, ms: number = NET_TIMEOUT_MS): Promise<Response> {
  return timedFetch(base, ms)(url, { ...init, method: 'POST', redirect: 'error' });
}
