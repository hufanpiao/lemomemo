// 带本次会话的令牌 POST 一个服务器函数：“＋”（ai-parse、ai-voice、token-admin，经 plus/data/fn-post.ts 的 postFn）和查找（note-search、ai-summarize，
// 经 smart-search/data/fn-call.ts）都经这里。经 appFetch，authorization、apikey 由这里加。B4b-3 评审第 7 条从 plus/data/fn-post.ts 挪到 platform，两边共用一份（查找原来自己写一套，401 不换令牌）。
// 别的功能各走各的：settings 的 account-api 直接 appFetch（回包是二进制），auth、reminders 等经 supabase-js 的 functions.invoke
// • sendFn：没登录返回 null、不发；401 先换一次令牌再发；交回 Response，返回码由调用方归类（token-admin 要分 409、429）
// • 超时和取消只由调用方的 signal 管：取令牌、换令牌途中取消也立刻按取消原因抛出（supabase-js 可能在等锁，不再等它）
// 纯 TS：不准 import React（A1）
import { buildInfo } from './env.ts';
import { appFetch } from './http.ts';
import { getSupabase } from './supabase/client.ts';

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
