// 带本次会话的令牌 POST 一个服务器函数（note-search、ai-summarize）：查找这一块调函数一律经这里，发送用 platform/fn-send.ts 的 sendFn
// （和“＋”同一份：401 换一次令牌再发；B4b-3 评审第 7 条，原来这里自己写一套、401 不换令牌）
// • 超时从取令牌之前就开始算：supabase-js 取令牌可能在等锁，取令牌途中超时、取消也立刻回（sendFn 按 signal 立刻抛）
// • 回：{ok: true, status, body}（body 读不懂是 null，状态码由调用方归类）；没登录 no_session；超时、取消 timeout；断网等 network
// 纯 TS：不准 import React（A1）
import { buildInfo } from '../../../platform/env.ts';
import { sendFn } from '../../../platform/fn-send.ts';
import { appFetch } from '../../../platform/http.ts';

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

/** signal：调用方取消（换了查询、关掉面板）；timeoutMs 到了也取消 */
export async function callFn(fn: string, body: unknown, signal: AbortSignal, timeoutMs: number, d: FnDeps = defaultFnDeps()): Promise<FnCall> {
  const ac = new AbortController();
  const stop = (): void => ac.abort();
  if (signal.aborted) stop();
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await sendFn(fn, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ac.signal, {
      fetch: d.fetch, url: `${d.base}/${fn}`, anonKey: d.anonKey,
      ...(d.accessToken ? { token: d.accessToken } : {}), ...(d.refresh ? { refresh: d.refresh } : {}),
    });
    if (res === null) return { ok: false, code: 'no_session' };
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: true, status: res.status, body: json };
  } catch {
    return { ok: false, code: ac.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}
