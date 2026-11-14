// 调 note-search {q, scope: 'main'}（架构 5.13 第 6 点“查询流程”）：带 JWT、apikey、X-App-Version（appFetch），3 秒超时
// （架构第 6 节 note-search 行“嵌入超时 3 秒”：客户端等满 3.5 秒算超时，留函数自己判超时、回 fallback 的余地）。
// 取令牌、appFetch、超时都在 fn-call.ts（ai-summarize 共用），这里只按状态码归类。
// 回：{hits} 意思相近的 id 和分数；或只按关键词的原因（FallbackReason）：服务器回的 consent / quota / timeout，
//   客户端自己判的：没登录、非 2xx、网络、读不懂都按 timeout（“这次超时了 · 再试一次”）；“今天用完”只认服务器回的 quota。
// 纯 TS：不准 import React（A1）
import { NOTE_SEARCH_FN, noteSearchRes, type FallbackReason } from '../../../../shared/schema/search.ts';
import { callFn, defaultFnDeps, type FnDeps } from './fn-call.ts';
import type { SemHit } from './find-local.ts';

export type SemResult = { ok: true; hits: SemHit[] } | { ok: false; reason: Exclude<FallbackReason, 'offline'>; code: string };

export const SEM_TIMEOUT_MS = 3_500;

export type SemDeps = FnDeps;
export const defaultSemDeps = defaultFnDeps;

/** signal：换了查询、关掉面板时调用方取消（取消时回 timeout，调用方自己丢掉结果） */
export async function noteSearch(q: string, signal: AbortSignal, d: SemDeps = defaultSemDeps()): Promise<SemResult> {
  const r = await callFn(NOTE_SEARCH_FN, { q, scope: 'main' }, signal, SEM_TIMEOUT_MS, d);
  if (!r.ok) return { ok: false, reason: 'timeout', code: r.code };
  if (r.status >= 200 && r.status < 300) {
    const p = noteSearchRes.safeParse(r.body);
    if (!p.success) return { ok: false, reason: 'timeout', code: 'bad_response' };
    return 'hits' in p.data ? { ok: true, hits: p.data.hits } : { ok: false, reason: p.data.fallback, code: p.data.fallback };
  }
  return { ok: false, reason: 'timeout', code: String((r.body as { error?: unknown } | null)?.error ?? r.status) };
}
