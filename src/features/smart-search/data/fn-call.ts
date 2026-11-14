// 带本次会话的令牌 POST 一个服务器函数（note-search、ai-summarize）：查找这一块调函数一律经这里，写法同 attachments/data/file-check-api.ts
// • 超时从取令牌之前就开始算：supabase-js 取令牌可能在等锁（plus/data/fn-post.ts 文件头同一个坑），取令牌途中超时、取消也立刻回
// • 回：{ok: true, status, body}（body 读不懂是 null，状态码由调用方归类）；没登录 no_session；超时、取消 timeout；断网等 network
// 纯 TS：不准 import React（A1）
import { buildInfo } from '../../../platform/env.ts';
import { sessionToken } from '../../../platform/files.ts';
import { appFetch } from '../../../platform/http.ts';

export interface FnDeps {
  accessToken(): Promise<string | null>;
  fetch: typeof appFetch;
  base: string;
  anonKey: string;
}

export const defaultFnDeps = (): FnDeps => ({
  accessToken: sessionToken,
  fetch: appFetch,
  base: `${buildInfo.supabaseUrl}/functions/v1`,
  anonKey: buildInfo.anonKey,
});

export type FnCall = { ok: true; status: number; body: unknown } | { ok: false; code: 'no_session' | 'timeout' | 'network' };

/** 等 p，signal 取消时立刻抛（不再等 p）；p 自己出错当 null */
function untilAbort(p: Promise<string | null>, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, () => resolve(null)).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** signal：调用方取消（换了查询、关掉面板）；timeoutMs 到了也取消 */
export async function callFn(fn: string, body: unknown, signal: AbortSignal, timeoutMs: number, d: FnDeps = defaultFnDeps()): Promise<FnCall> {
  const ac = new AbortController();
  const stop = (): void => ac.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const at = await untilAbort(d.accessToken(), ac.signal);
    if (!at) return { ok: false, code: 'no_session' };
    const res = await d.fetch(`${d.base}/${fn}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${at}`, apikey: d.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: 'no-store',
    });
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
