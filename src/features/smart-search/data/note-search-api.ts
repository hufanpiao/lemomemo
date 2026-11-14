// 调 note-search {q, scope: 'main'}（架构 5.13 第 6 点“查询流程”）：带 JWT、apikey、X-App-Version（appFetch），3 秒超时
// （架构第 6 节 note-search 行“嵌入超时 3 秒”：客户端等满 3.5 秒算超时，留函数自己判超时、回 fallback 的余地）。
// 写法同 attachments/data/file-check-api.ts（取令牌、appFetch、读 JSON、按状态码归类），不另起一套。
// 回：{hits} 意思相近的 id 和分数；或只按关键词的原因（FallbackReason）：服务器回的 consent / quota / timeout，
//   客户端自己判的：没登录、5xx、网络、读不懂、426 都按 timeout（“这次超时了 · 再试一次”），429 按 quota。
// 纯 TS：不准 import React（A1）
import { NOTE_SEARCH_FN, noteSearchRes, type FallbackReason } from '../../../../shared/schema/search.ts';
import { buildInfo } from '../../../platform/env.ts';
import { sessionToken } from '../../../platform/files.ts';
import { appFetch } from '../../../platform/http.ts';
import type { SemHit } from './find-local.ts';

export type SemResult = { ok: true; hits: SemHit[] } | { ok: false; reason: Exclude<FallbackReason, 'offline'>; code: string };

export const SEM_TIMEOUT_MS = 3_500;

export interface SemDeps {
  accessToken(): Promise<string | null>;
  fetch: typeof appFetch;
  base: string;
  anonKey: string;
}

export const defaultSemDeps = (): SemDeps => ({
  accessToken: sessionToken,
  fetch: appFetch,
  base: `${buildInfo.supabaseUrl}/functions/v1`,
  anonKey: buildInfo.anonKey,
});

/** signal：换了查询、关掉面板时调用方取消（取消时回 timeout，调用方自己丢掉结果） */
export async function noteSearch(q: string, signal: AbortSignal, d: SemDeps = defaultSemDeps()): Promise<SemResult> {
  const at = await d.accessToken();
  if (!at) return { ok: false, reason: 'timeout', code: 'no_session' };
  const ac = new AbortController();
  const stop = (): void => ac.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, SEM_TIMEOUT_MS);
  try {
    const res = await d.fetch(`${d.base}/${NOTE_SEARCH_FN}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${at}`, apikey: d.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ q, scope: 'main' }),
      signal: ac.signal,
      cache: 'no-store',
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) {
      const p = noteSearchRes.safeParse(body);
      if (!p.success) return { ok: false, reason: 'timeout', code: 'bad_response' };
      return 'hits' in p.data ? { ok: true, hits: p.data.hits } : { ok: false, reason: p.data.fallback, code: p.data.fallback };
    }
    const code = String((body as { error?: unknown } | null)?.error ?? res.status);
    if (code === 'consent_required') return { ok: false, reason: 'consent', code };
    return { ok: false, reason: res.status === 429 ? 'quota' : 'timeout', code };
  } catch {
    return { ok: false, reason: 'timeout', code: ac.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}
