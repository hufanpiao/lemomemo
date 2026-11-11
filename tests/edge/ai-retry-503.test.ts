// Gemini 503 重试一次（supabase/functions/_shared/ai/retry.ts；11-11 B3 iPhone 实测 40 次里 4 次 503）。
// 只认 503；两次合计不超过 req.timeoutMs；剩的时间不够就不重试；最多一次。正式 ai-voice（voiceWithAI）用它，ai-parse 不用。服务商一律用桩。
import { describe, expect, it } from 'vitest';
import { isValidTz } from '../../shared/core/tz.ts';
import { checkDefaultDay, checkParseOutput, checkVoiceOutput, normLocale, normProjects, type AiItem } from '../../shared/schema/ai.ts';
import { handle as voiceHandle, VOICE_RETRY_COUNT_LIMIT, voiceRetryKey, type Deps as VoiceDeps } from '../../supabase/functions/ai-voice/core.ts';
import { VOICE_TIMEOUT_MS } from '../../supabase/functions/_shared/ai/params.ts';
import { makeParseWithAI, type ParseInput } from '../../supabase/functions/_shared/ai/parse-core.ts';
import type { AiRequest, AiResult } from '../../supabase/functions/_shared/ai/provider.ts';
import { generateRetry503, is503, RETRY_BACKOFF_MS, RETRY_MIN_LEFT_MS } from '../../supabase/functions/_shared/ai/retry.ts';
import { fakeGate, okJson, StubProvider, UA, type GateOpts } from './ai-fakes.ts';

const E503: AiResult = { ok: false, reason: 'error', status: 503 };
const REQ: AiRequest = { system: 's', parts: [{ text: 't' }], schema: {}, params: { temperature: 0, candidateCount: 1 }, timeoutMs: 15_000 };

/** 假时钟：每次调服务商花 cost 毫秒，sleep 照实推进 */
function rig(replies: AiResult[], cost: number[]) {
  let t = 0;
  let i = 0;
  const slept: number[] = [];
  const p = new StubProvider(() => {
    t += cost[i] ?? 0;
    return replies[i++] ?? okJson({});
  });
  return { p, slept, deps: { clock: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; } } };
}

describe('generateRetry503', () => {
  it('只认 reason = error 且 status = 503', () => {
    expect(is503(E503)).toBe(true);
    for (const r of [{ ok: false, reason: 'error', status: 500 }, { ok: false, reason: 'quota', status: 429 }, { ok: false, reason: 'timeout' },
      { ok: false, reason: 'error' }, okJson({})] as AiResult[]) expect(is503(r)).toBe(false);
  });
  it('第一次成功：只调一次，不等待', async () => {
    const r = rig([okJson({ a: 1 })], [2000]);
    const o = await generateRetry503(r.p, REQ, r.deps);
    expect([o.retried, r.p.calls.length, r.slept]).toEqual([false, 1, []]);
  });
  it('503 → 等 300 ms 再发一次；第二次的超时是剩下的时间（两次合计不超过 15 秒）', async () => {
    const r = rig([E503, okJson({ a: 1 })], [2000, 3000]);
    const o = await generateRetry503(r.p, REQ, r.deps);
    expect(o).toEqual({ result: okJson({ a: 1 }), retried: true });
    expect(r.slept).toEqual([RETRY_BACKOFF_MS]);
    expect(r.p.calls.map((c) => c.timeoutMs)).toEqual([15_000, 15_000 - 2000 - RETRY_BACKOFF_MS]);
    expect(r.p.calls[1]?.system).toBe(REQ.system);
  });
  it('两次都 503：只重试一次，回第二次的结果', async () => {
    const r = rig([E503, E503, okJson({})], [1000, 1000]);
    const o = await generateRetry503(r.p, REQ, r.deps);
    expect([o.retried, o.result, r.p.calls.length]).toEqual([true, E503, 2]);
  });
  it('503 时离截止只剩不到 4.3 秒：不重试', async () => {
    const r = rig([E503], [15_000 - RETRY_MIN_LEFT_MS - RETRY_BACKOFF_MS + 1]);
    const o = await generateRetry503(r.p, REQ, r.deps);
    expect([o.retried, r.p.calls.length, r.slept]).toEqual([false, 1, []]);
  });
  it('500、429、超时、没有状态码的错误都不重试', async () => {
    for (const first of [{ ok: false, reason: 'error', status: 500 }, { ok: false, reason: 'quota', status: 429 }, { ok: false, reason: 'timeout' }, { ok: false, reason: 'error' }] as AiResult[]) {
      const r = rig([first], [100]);
      const o = await generateRetry503(r.p, REQ, r.deps);
      expect([o.retried, o.result, r.p.calls.length]).toEqual([false, first, 1]);
    }
  });
});

describe('正式路径：voiceWithAI 503 重试一次，parseWithAI 不重试', () => {
  const { parseWithAI, voiceWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
  const input: ParseInput = { text: '明天下午三点开会', now: Date.UTC(2026, 9, 28, 3, 0), tz: 'Asia/Seoul', locale: 'zh', projects: [], features: ['event', 'todo'] };
  it('voiceWithAI：第一次 503、第二次成功 → ok，第二次超时不超过 15 秒', async () => {
    let n = 0;
    const p = new StubProvider(() => (++n === 1 ? E503 : okJson({ transcript: '明天下午三点开会', items: [{ kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', date_basis: 'rel' }] })));
    const r = await voiceWithAI({ ...input, audio: new Uint8Array([1]), mime: 'audio/mp4' }, p);
    expect(r.ok).toBe(true);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]?.timeoutMs).toBe(VOICE_TIMEOUT_MS);
    expect(p.calls[1]?.timeoutMs).toBeLessThanOrEqual(VOICE_TIMEOUT_MS - RETRY_BACKOFF_MS);
  });
  it('voiceWithAI：两次都 503 → error，状态码 503', async () => {
    const p = new StubProvider(() => E503);
    const r = await voiceWithAI({ ...input, audio: new Uint8Array([1]), mime: 'audio/mp4' }, p);
    expect(r).toMatchObject({ ok: false, reason: 'error', status: 503 });
    expect(p.calls).toHaveLength(2);
  });
  it('parseWithAI：503 只调一次（5 秒超时，不重试）', async () => {
    const p = new StubProvider(() => E503);
    const r = await parseWithAI(input, p);
    expect(r).toMatchObject({ ok: false, reason: 'error', status: 503 });
    expect(p.calls).toHaveLength(1);
  });
});

describe('ai-voice：503 重试透出 retried（11-11 架构复审）', () => {
  const { voiceWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
  const EV = { kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', date_basis: 'rel' };
  const OK = okJson({ transcript: '明天下午三点开会', items: [EV] });
  function run(replies: (AiResult | 'throw')[], extra: Partial<VoiceDeps<AiItem>> = {}, o: GateOpts = {}) {
    let n = 0;
    const g = fakeGate({ reply: () => { const x = replies[n++] ?? OK; if (x === 'throw') throw new Error('x'); return x; }, ...o });
    const fails: { code: string; fields: string[] }[] = [];
    const deps: VoiceDeps<AiItem> = {
      ...g, authenticate: async () => ({ ok: true as const, user: { userId: UA } }),
      logic: { normLocale, normProjects, isValidTz, checkDefaultDay, voiceWithAI },
      async logFail(_u, code, fields) { fails.push({ code, fields }); },
      ...extra,
    };
    const req = new Request('http://kong/functions/v1/ai-voice', {
      method: 'POST', body: new Uint8Array(5),
      headers: { 'content-type': 'audio/mp4', 'x-now': String(Date.UTC(2026, 9, 28, 3, 0)), 'x-tz': 'Asia/Seoul', 'x-locale': 'zh' },
    });
    return { g, fails, res: voiceHandle(req, deps) };
  }
  it('voiceWithAI：重试过的带 retried: true，没重试的不带', async () => {
    const input = { text: '', now: Date.UTC(2026, 9, 28, 3, 0), tz: 'Asia/Seoul', locale: 'zh' as const, projects: [], features: ['event'] as const, audio: new Uint8Array([1]), mime: 'audio/mp4' };
    let n = 0;
    expect(await voiceWithAI({ ...input, features: ['event'] }, new StubProvider(() => (++n === 1 ? E503 : OK)))).toMatchObject({ ok: true, retried: true });
    expect(await voiceWithAI({ ...input, features: ['event'] }, new StubProvider(() => E503))).toMatchObject({ ok: false, status: 503, retried: true });
    expect(await voiceWithAI({ ...input, features: ['event'] }, new StubProvider(() => OK))).not.toHaveProperty('retried');
  });
  it('重试后成功：counters 记 voice-retry:global:<太平洋日期> 加一，不写失败日志', async () => {
    const { g, fails, res } = run([E503, OK]);
    expect((await (await res).json())['intent']).toBe('record');
    expect(voiceRetryKey(Date.UTC(2026, 9, 28, 3, 0))).toBe('voice-retry:global:2026-10-27');
    expect(g.counts.get('voice-retry:global:2026-10-27')).toBe(1);
    expect(fails).toEqual([]);
    expect(VOICE_RETRY_COUNT_LIMIT).toBeGreaterThanOrEqual(1_000_000);
  });
  it('没重试的成功不记计数；重试后仍失败：失败日志 fields 带 retried=1，不记 voice-retry', async () => {
    const a = run([OK]);
    await a.res;
    expect([...a.g.counts.keys()].some((k) => k.startsWith('voice-retry:'))).toBe(false);
    const b = run([E503, E503]);
    expect((await (await b.res).json())).toEqual({ ai_failed: true, reason: 'error' });
    expect(b.fails).toEqual([{ code: 'ai_error', fields: ['status=503', 'retried=1', 'bytes=<16k'] }]);
    expect([...b.g.counts.keys()].some((k) => k.startsWith('voice-retry:'))).toBe(false);
  });
  it('记计数出错不影响回答', async () => {
    const { g, res } = run([E503, OK], { rate: async (k: string) => { if (k.startsWith('voice-retry:')) throw new Error('db'); return true; } });
    expect((await (await res).json())['intent']).toBe('record');
    expect(g.logs).toContain('voice_retry_count_failed');
  });
});
