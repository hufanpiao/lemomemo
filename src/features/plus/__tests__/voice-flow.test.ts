// 一段录音交给 ai-voice 到出结果（data/voice-flow.ts；B3 FA-3）：结果归类（不认识的 intent 走本机规则退路、原话不丢）、
// 超时按体积、网络错误自动重试 1 次、离线不重试、用户取消、上传前的接缝原样交出
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiReqCtx, TypeCtx } from '../data/type-flow.ts';
import { uploadTimeoutMs } from '../data/record-logic.ts';
import { sendVoice, toUpload, voiceFinal, voiceResult } from '../data/voice-flow.ts';

const ITEM = {
  kind: 'todo', title: '买猫砂', date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
};
const ok = { intent: 'record', confidence: 1, transcript: '买猫砂', quota_left: 41, items: [ITEM] };
const ctx = { now: 0, tz: 'Asia/Seoul', locale: 'zh', projects: [], scope: 'main' } as unknown as AiReqCtx;
const clip = { blob: new Blob([new Uint8Array(1000)], { type: 'audio/mp4' }), mime: 'audio/mp4' };

afterEach(() => {
  vi.useRealTimers();
});

describe('返回归类', () => {
  it('识别成功：条目、转写、剩余次数', () => {
    const r = voiceResult(ok);
    expect(r.kind).toBe('record');
    if (r.kind === 'record') {
      expect(r.items).toHaveLength(1);
      expect(r.transcript).toBe('买猫砂');
      expect(r.quotaLeft).toBe(41);
    }
  });
  it('不认识的 intent 但带着转写：走本机规则（原话不丢）', () => {
    expect(voiceResult({ ...ok, intent: 'summarize_week' })).toEqual({ kind: 'rule', transcript: '买猫砂', reason: expect.any(String) });
  });
  it('不认识的 intent、也没有转写：AI 没回应（可以重试）', () => {
    expect(voiceResult({ intent: 'weird' })).toMatchObject({ kind: 'failed', fail: null });
  });
  it('空转写、没有条目：没听清', () => {
    expect(voiceResult({ ...ok, transcript: '', items: [] })).toEqual({ kind: 'no_speech' });
  });
  it('有转写但没拆出条目：用转写走本机规则', () => {
    expect(voiceResult({ ...ok, items: [] })).toMatchObject({ kind: 'rule', transcript: '买猫砂' });
  });
  it('次数用完（quota_out，或 fallback 原因是 quota）；没同意；功能没开', () => {
    expect(voiceResult({ quota_out: true, quota_left: 0 })).toEqual({ kind: 'quota_out' });
    expect(voiceResult({ fallback: true, reason: 'quota' })).toEqual({ kind: 'quota_out' });
    expect(voiceResult({ consent_required: true })).toEqual({ kind: 'consent_required' });
    expect(voiceResult({ fallback: true, reason: 'feature_off' })).toEqual({ kind: 'fallback', reason: 'feature_off' });
  });
});

describe('收尾（voiceFinal）', () => {
  const tctx = { now: 0, tz: 'Asia/Seoul', locale: 'zh', projects: [], day: null } as unknown as TypeCtx;
  it('识别成功：记下 AI 的条目（origin = ai）；不认识的 intent：转写走本机规则（origin = rule）', () => {
    const a = voiceFinal(voiceResult(ok), tctx, true);
    expect(a).toMatchObject({ do: 'save', raw: '买猫砂', plan: { status: 'saved', origin: 'ai', quotaLeft: 41 } });
    const b = voiceFinal(voiceResult({ ...ok, intent: 'summarize_week' }), tctx, true);
    expect(b).toMatchObject({ do: 'save', raw: '买猫砂', plan: { status: 'saved_rule', origin: 'rule' } });
    if (b.do === 'save') expect(b.plan.items[0]?.title).toBe('买猫砂');
  });
  it('提示条种类：没听清、次数用完、没同意 / 不整理 → 再说一次、AI 没回应（在线 / 不在线）、取消回到没按', () => {
    expect(voiceFinal({ kind: 'no_speech' }, tctx, true)).toEqual({ do: 'note', status: 'no_speech', note: 'no_speech' });
    expect(voiceFinal({ kind: 'quota_out' }, tctx, true)).toEqual({ do: 'note', status: 'quota_out', note: 'quota' });
    expect(voiceFinal({ kind: 'consent_required' }, tctx, true)).toMatchObject({ note: 'redo' });
    expect(voiceFinal({ kind: 'fallback', reason: 'feature_off' }, tctx, true)).toMatchObject({ note: 'redo' });
    const failed = { kind: 'failed', reason: 'network', fail: 'network' } as const;
    expect(voiceFinal(failed, tctx, true)).toMatchObject({ status: 'ai_failed', note: 'ai_failed' });
    expect(voiceFinal(failed, tctx, false)).toMatchObject({ note: 'net_down' });
    expect(voiceFinal({ kind: 'cancelled' }, tctx, true)).toEqual({ do: 'idle' });
  });
});

describe('送出', () => {
  it('上传前的接缝：现在原样交出（直传）', async () => {
    expect(await toUpload(clip)).toBe(clip);
  });

  it('成功：带上录音和类型', async () => {
    const call = vi.fn(async (_req: unknown, _signal: AbortSignal) => ok);
    const r = await sendVoice(clip, ctx, call, { online: () => true });
    expect(r.kind).toBe('record');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toMatchObject({ audio: clip.blob, mime: 'audio/mp4' });
  });

  it('网络错误：在线时自动重试 1 次，再错就失败（网络原因）', async () => {
    const call = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await sendVoice(clip, ctx, call, { online: () => true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ kind: 'failed', reason: 'network', fail: 'network' });
  });

  it('网络错误、浏览器说离线：不重试', async () => {
    const call = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await sendVoice(clip, ctx, call, { online: () => false });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('超时按体积算（uploadTimeoutMs），到了算 timeout、不自动重试', async () => {
    vi.useFakeTimers();
    const call = vi.fn(
      (_req: unknown, signal: AbortSignal) =>
        new Promise<unknown>((_, no) => signal.addEventListener('abort', () => no(signal.reason as Error))),
    );
    const p = sendVoice(clip, ctx, call, { online: () => true });
    await vi.advanceTimersByTimeAsync(uploadTimeoutMs(clip.blob.size) - 1);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ kind: 'failed', reason: 'timeout', fail: 'timeout' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('用户点了取消：cancelled，不重试', async () => {
    const ac = new AbortController();
    const call = vi.fn(
      (_req: unknown, signal: AbortSignal) =>
        new Promise<unknown>((_, no) => signal.addEventListener('abort', () => no(signal.reason as Error))),
    );
    const p = sendVoice(clip, ctx, call, { online: () => true, signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ kind: 'cancelled' });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
