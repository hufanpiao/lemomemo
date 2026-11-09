// AI 返回的判读（data/ai-outcome.ts；B3 任务单 Q2、FA-1；架构审 M9）：intent 穷举，不认识的 intent 一律 ai_failed
import { describe, expect, it } from 'vitest';
import { outcomeOf } from '../data/ai-outcome.ts';

const ITEM = {
  kind: 'event', title: 'meet', date: '2026-11-08', time: '15:00', duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: 'rel', anniv: null, confirm: null,
};

describe('outcomeOf', () => {
  it('record：items、quota_left 原样带出', () => {
    const o = outcomeOf({ intent: 'record', confidence: 1, items: [ITEM], quota_left: 42 });
    expect(o).toEqual({ kind: 'record', items: [ITEM], quotaLeft: 42, transcript: null });
  });

  it('ai-voice 带 transcript', () => {
    const o = outcomeOf({ intent: 'record', confidence: 1, items: [ITEM], quota_left: 3, transcript: 'hi' });
    expect(o).toMatchObject({ kind: 'record', transcript: 'hi' });
  });

  it('“记下”但条目为空：一律当失败（架构师 11-07），打字、录音都一样，不当“已记下 0 条”', () => {
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [], quota_left: 3 })).toEqual({ kind: 'ai_failed', reason: 'empty_items' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [], quota_left: 3, transcript: 'hi' })).toEqual({ kind: 'ai_failed', reason: 'empty_items' });
  });

  it('Q2 ②：不认识的 intent（以后的 search、summarize）当 ai_failed，不报错', () => {
    expect(outcomeOf({ intent: 'search', confidence: 1, items: [ITEM], quota_left: 9 })).toEqual({ kind: 'ai_failed', reason: 'unknown_intent' });
    expect(outcomeOf({ intent: 42, items: [] })).toEqual({ kind: 'ai_failed', reason: 'unknown_intent' });
  });

  it('读不懂的（缺字段、多字段、不是对象）一律 ai_failed', () => {
    expect(outcomeOf(null)).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf('x')).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [ITEM] })).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [], quota_left: 1, extra: 1 })).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [{ ...ITEM, kind: 'spell' }], quota_left: 1 })).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
  });

  it('其余几支', () => {
    expect(outcomeOf({ fallback: true, reason: 'feature_off' })).toEqual({ kind: 'fallback', reason: 'feature_off' });
    expect(outcomeOf({ consent_required: true })).toEqual({ kind: 'consent_required' });
    expect(outcomeOf({ quota_out: true, quota_left: 0 })).toEqual({ kind: 'quota_out' });
    expect(outcomeOf({ ai_failed: true, reason: 'timeout' })).toEqual({ kind: 'ai_failed', reason: 'timeout' });
  });
});
