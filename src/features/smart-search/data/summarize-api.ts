// 调 ai-summarize（架构 5.14 第 4 点；契约 shared/schema/summarize.ts）：主页面只送普通记录的 id、scope 'main'，不带令牌（隐私记这一批不做）
// • 送之前先等这几条发出去（outbox 里还有这几个 id 的就等，最多 SYNC_WAIT_MS），不等完也照送：服务器查不到的放进 missing，卡片写“N 条还没同步”
// • 客户端等 SUMMARY_TIMEOUT_MS（函数自己 10 秒超时回 fallback，多留 2 秒）
// • 回：成功 {summary, cited, missing, quotaLeft}；不成：consent（没同意）/ quota（今天用完）/ all_missing（一条都查不到）/ failed（别的：超时、断网、读不懂）
// 纯 TS：不准 import React（A1）
import { AI_SUMMARIZE_FN, SUMMARY_ASK_MAX, summarizeRes, type SummaryRef } from '../../../../shared/schema/summarize.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { getBoot } from '../../../core/boot.ts';
import { callFn, defaultFnDeps, type FnDeps } from './fn-call.ts';

export const SUMMARY_TIMEOUT_MS = 12_000;
export const SYNC_WAIT_MS = 3_000;
const SYNC_POLL_MS = 250;

export type SumFail = 'consent' | 'quota' | 'all_missing' | 'failed';
export type SumResult = { ok: true; summary: string; cited: string[]; missing: string[]; quotaLeft: number } | { ok: false; reason: SumFail; code: string };

export interface SumReq {
  ids: readonly SummaryRef[];
  ask: string;
  now: number;
  tz: Tz;
  locale: string;
}

/** outbox 里还有没有这几个 id 的（没启动、读不了当没有） */
async function unsent(ids: ReadonlySet<string>): Promise<boolean> {
  const ob = getBoot()?.outbox;
  if (!ob) return false;
  try {
    return (await ob.list()).some((i) => ids.has(i.id));
  } catch {
    return false;
  }
}

/** 等这几条发出去，最多 ms；返回还剩没发的（日志用） */
export async function waitSent(ids: readonly SummaryRef[], signal: AbortSignal, ms = SYNC_WAIT_MS, has: (ids: ReadonlySet<string>) => Promise<boolean> = unsent): Promise<boolean> {
  const set = new Set(ids.map((x) => x.id));
  const until = Date.now() + ms;
  for (;;) {
    if (signal.aborted || !(await has(set))) return false;
    if (Date.now() >= until) return true;
    await new Promise((r) => setTimeout(r, SYNC_POLL_MS));
  }
}

export async function summarize(req: SumReq, signal: AbortSignal, d: FnDeps = defaultFnDeps()): Promise<SumResult> {
  const body = { ids: req.ids, ask: [...req.ask].slice(0, SUMMARY_ASK_MAX).join(''), now: req.now, tz: req.tz, locale: req.locale, scope: 'main' as const };
  const r = await callFn(AI_SUMMARIZE_FN, body, signal, SUMMARY_TIMEOUT_MS, d);
  if (!r.ok) return { ok: false, reason: 'failed', code: r.code };
  const err = String((r.body as { error?: unknown } | null)?.error ?? r.status);
  if (r.status === 400 && err === 'all_missing') return { ok: false, reason: 'all_missing', code: err };
  if (r.status < 200 || r.status >= 300) return { ok: false, reason: 'failed', code: err };
  const p = summarizeRes.safeParse(r.body);
  if (!p.success) return { ok: false, reason: 'failed', code: 'bad_response' };
  const v = p.data;
  if ('summary' in v) return { ok: true, summary: v.summary, cited: v.cited, missing: v.missing, quotaLeft: v.quota_left };
  if ('consent_required' in v) return { ok: false, reason: 'consent', code: 'consent_required' };
  if ('quota_out' in v) return { ok: false, reason: 'quota', code: 'quota_out' };
  return { ok: false, reason: v.reason === 'quota' ? 'quota' : 'failed', code: v.reason };
}
