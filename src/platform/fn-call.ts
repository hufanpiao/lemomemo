// 带本次会话的令牌 POST 一个服务器函数，套超时、读包体：全仓调服务器函数的“取令牌 + 超时 + 发送 + 读错误体”只这一份（fnRequest）。
// 发送用 platform/fn-send.ts 的 sendFn（401 先换一次令牌再发）
// • 超时从取令牌之前就开始算，一直算到包体读完（拿到响应头以后断流又不断开，blob()、json() 会一直挂着：和到点赛跑，不靠 fetch 实现中断读包体）；
//   supabase-js 取令牌可能在等锁，取令牌途中超时、取消也立刻回（sendFn 按 signal 立刻抛）
// • 回：2xx {ok: true, status, value}（value 是 read 读出的，不给 read 按 JSON 读、读不懂为 null）；不是 2xx {ok: false, code: 'http', status, body}
//   （body 按 JSON 读，读不懂为 null；状态码、错误码由调用方归类，口径用 shared/core/http-kind.ts）；没登录 no_session；超时、取消 timeout；
//   断网、读包体中途断开等 network
// • callFn：JSON 进、JSON 出的简写（查找、AI 助手、AI 服务商），不分 2xx 与否都回 {ok: true, status, body}
// 纯 TS：不准 import React
import { buildInfo } from './env.ts';
import { sendFn, type FnPostOptions, type FnReq } from './fn-send.ts';
import { appFetch } from './http.ts';

export interface FnRequestOptions<T> extends FnPostOptions {
  /** 调用方取消（换了查询、关掉面板）；不给就只有超时 */
  signal?: AbortSignal;
  timeoutMs: number;
  /** 2xx 时怎么读包体；不给按 JSON 读（读不懂为 null） */
  read?: (res: Response) => Promise<T>;
}

export type FnReply<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; code: 'http'; status: number; body: unknown }
  | { ok: false; code: 'no_session' | 'timeout' | 'network' };

/** 响应体按 JSON 读，读不出来当 null */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export async function fnRequest<T = unknown>(fn: string, req: FnReq, o: FnRequestOptions<T>): Promise<FnReply<T>> {
  const ac = new AbortController();
  let expire: (e: unknown) => void = () => undefined;
  const expired = new Promise<never>((_r, rej) => {
    expire = rej;
  });
  expired.catch(() => undefined);
  // 超时、调用方取消都从这一个 signal 走：发送、取令牌由 sendFn 按它中止，读包体和 expired 赛跑
  ac.signal.addEventListener('abort', () => expire(new Error('aborted')), { once: true });
  const stop = (): void => ac.abort();
  if (o.signal?.aborted) stop();
  o.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, o.timeoutMs);
  const send: FnPostOptions = {
    ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.url ? { url: o.url } : {}), ...(o.anonKey !== undefined ? { anonKey: o.anonKey } : {}),
    ...(o.token ? { token: o.token } : {}), ...(o.refresh ? { refresh: o.refresh } : {}),
  };
  try {
    const res = await Promise.race([sendFn(fn, req, ac.signal, send), expired]);
    if (res === null) return { ok: false, code: 'no_session' };
    if (res.ok) return { ok: true, status: res.status, value: (await Promise.race([o.read ? o.read(res) : readJson(res), expired])) as T };
    return { ok: false, code: 'http', status: res.status, body: await Promise.race([readJson(res), expired]) };
  } catch {
    return { ok: false, code: ac.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', stop);
  }
}

export interface FnDeps {
  /** 本次会话的令牌；不给用 sendFn 默认的（supabase-js 的会话） */
  accessToken?(): Promise<string | null>;
  /** 401 时换一次令牌；不给用 sendFn 默认的 */
  refresh?(): Promise<string | null>;
  fetch: typeof appFetch;
  base: string;
  anonKey: string;
}

export const defaultFnDeps = (): FnDeps => ({
  fetch: appFetch,
  base: `${buildInfo.supabaseUrl}/functions/v1`,
  anonKey: buildInfo.anonKey,
});

export type FnCall = { ok: true; status: number; body: unknown } | { ok: false; code: 'no_session' | 'timeout' | 'network' };

/** JSON 进、JSON 出。signal：调用方取消（换了查询、关掉面板）；timeoutMs 到了也取消 */
export async function callFn(fn: string, body: unknown, signal: AbortSignal, timeoutMs: number, d: FnDeps = defaultFnDeps()): Promise<FnCall> {
  const r = await fnRequest(fn, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {
    signal, timeoutMs, fetch: d.fetch, url: `${d.base}/${fn}`, anonKey: d.anonKey,
    ...(d.accessToken ? { token: d.accessToken } : {}), ...(d.refresh ? { refresh: d.refresh } : {}),
  });
  if (r.ok) return { ok: true, status: r.status, body: r.value };
  return r.code === 'http' ? { ok: true, status: r.status, body: r.body } : r;
}
