// 带本次会话的令牌 POST 一个服务器函数（ai-parse、ai-voice、token-admin）：这类事只在这里做。经 appFetch，authorization、apikey 由这里加
// • sendFn：没登录返回 null、不发；401 先换一次令牌再发；交回 Response，返回码由调用方归类（token-admin 要分 409、429）
// • postFn：2xx 是 JSON 就原样交回，不是 JSON 抛 SendError('bad_response')；没登录、非 2xx 抛 SendError('http')；断网的 TypeError 原样抛
// • 超时和取消只由调用方的 signal 管：取令牌、换令牌途中取消也立刻按取消原因抛出（supabase-js 可能在等锁，不再等它）
// 纯 TS：不准 import React（A1）
import { buildInfo } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { SendError } from './send-error.ts';

export interface FnPostOptions {
  fetch?: typeof appFetch;
  url?: string;
  anonKey?: string;
  /** 取这次会话的 access token；没登录返回 null */
  token?: () => Promise<string | null>;
  /** 401 时换一次 token；换不到返回 null */
  refresh?: () => Promise<string | null>;
}

/** 本次会话的 JWT（没登录为 null） */
async function sessionToken(): Promise<string | null> {
  const db = await getSupabase();
  const { data, error } = await db.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

async function refreshedToken(): Promise<string | null> {
  const db = await getSupabase();
  const { data, error } = await db.auth.refreshSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

/** 等 p，但 signal 取消时立刻按取消原因抛出（不再等 p）；p 自己出错当 null */
function tokenOr(p: () => Promise<string | null>, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', stop, { once: true });
    p().then(resolve, () => resolve(null)).finally(() => signal.removeEventListener('abort', stop));
  });
}

export interface FnReq {
  /** content-type 和各自的参数头 */
  headers: Record<string, string>;
  body: BodyInit;
}

/** POST <supabaseUrl>/functions/v1/<fn>，交回 Response；没登录返回 null、不发请求 */
export async function sendFn(fn: string, req: FnReq, signal: AbortSignal, o: FnPostOptions = {}): Promise<Response | null> {
  const doFetch = o.fetch ?? appFetch;
  const jwt = await tokenOr(o.token ?? sessionToken, signal);
  if (jwt === null) return null;
  const url = o.url ?? `${buildInfo.supabaseUrl}/functions/v1/${fn}`;
  const send = (t: string): Promise<Response> =>
    doFetch(url, {
      method: 'POST',
      headers: { ...req.headers, authorization: `Bearer ${t}`, apikey: o.anonKey ?? buildInfo.anonKey },
      body: req.body,
      signal,
      cache: 'no-store',
    });
  let res = await send(jwt);
  if (res.status === 401) {
    // 令牌刚好在两次调用之间过期，不该算失败；换来的和原来一样就不再发
    const fresh = await tokenOr(o.refresh ?? refreshedToken, signal);
    if (fresh !== null && fresh !== jwt) res = await send(fresh);
  }
  return res;
}

/** 同 sendFn，只收 2xx 的 JSON，返回已 parse 的值 */
export async function postFn(fn: string, req: FnReq, signal: AbortSignal, o: FnPostOptions = {}): Promise<unknown> {
  const res = await sendFn(fn, req, signal, o);
  if (res === null || !res.ok) throw new SendError('http');
  try {
    return (await res.json()) as unknown;
  } catch (e) {
    // 读包体时被取消（超时）原样抛，调用方认成 timeout
    if (signal.aborted) throw e;
    throw new SendError('bad_response');
  }
}
