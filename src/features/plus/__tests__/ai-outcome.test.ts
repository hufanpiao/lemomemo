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
    expect(o).toEqual({ kind: 'record', items: [ITEM], quotaLeft: 42, transcript: null, confidence: 1 });
  });

  it('ai-voice 带 transcript', () => {
    const o = outcomeOf({ intent: 'record', confidence: 1, items: [ITEM], quota_left: 3, transcript: 'hi' });
    expect(o).toMatchObject({ kind: 'record', transcript: 'hi' });
  });

  it('“记下”但条目为空：一律当失败（架构师 11-07），打字、录音都一样，不当“已记下 0 条”', () => {
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [], quota_left: 3 })).toEqual({ kind: 'ai_failed', reason: 'empty_items' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [], quota_left: 3, transcript: 'hi' })).toEqual({ kind: 'ai_failed', reason: 'empty_items' });
  });

  it('Q2 ②：不认识的 intent 当 ai_failed，不报错', () => {
    expect(outcomeOf({ intent: 'spell', confidence: 1, items: [ITEM], quota_left: 9 })).toEqual({ kind: 'ai_failed', reason: 'unknown_intent' });
    expect(outcomeOf({ intent: 42, items: [] })).toEqual({ kind: 'ai_failed', reason: 'unknown_intent' });
  });

  it('B4b-3：查找、总结带 query；取消、改期、完成带 target（过 resolveTarget，相关待办按原话判）；items 一律不看', () => {
    const query = { text: '牙医', range: null, kinds: ['event'], done: 'any' };
    expect(outcomeOf({ intent: 'search', confidence: 0.9, query, quota_left: 9 })).toEqual({
      kind: 'intent', ask: { intent: 'search', query }, confidence: 0.9, quotaLeft: 9, transcript: null,
    });
    const target = { text: '会', date: '2026-11-09', time: null, kinds: ['event'] };
    const o = outcomeOf({ intent: 'cancel', confidence: 0.8, target, to: null, quota_left: 2 }, '明天的会取消了，相关待办也删掉');
    expect(o).toMatchObject({ kind: 'intent', confidence: 0.8, ask: { intent: 'cancel', target: { text: '会' }, to: null, bulkRefused: false, relatedTodos: true } });
    const r = outcomeOf({ intent: 'reschedule', confidence: 1, target, to: { date: '2026-11-10', time: null }, quota_left: 2 });
    expect(r).toMatchObject({ kind: 'intent', ask: { intent: 'reschedule', to: { date: '2026-11-10', time: null }, relatedTodos: false } });
  });

  it('读不懂的（缺字段、多字段、不是对象）一律 ai_failed', () => {
    expect(outcomeOf(null)).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf('x')).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [ITEM] })).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [], quota_left: 1, extra: 1 })).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
    expect(outcomeOf({ intent: 'record', confidence: 1, items: [{ ...ITEM, kind: 'spell' }], quota_left: 1 })).toEqual({ kind: 'ai_failed', reason: 'bad_response' });
  });

  it('S3：日程、待办的 title 超过 160、short 超过 32（rows.ts 行约束）当读不懂，退回本机规则；刚好在上限内照收；纪念日不查', () => {
    const rec = (it: Record<string, unknown>) => outcomeOf({ intent: 'record', confidence: 1, items: [ITEM, it], quota_left: 3 });
    const BAD = { kind: 'ai_failed', reason: 'bad_response' };
    for (const kind of ['event', 'todo']) {
      expect(rec({ ...ITEM, kind, title: 'x'.repeat(161) })).toEqual(BAD);
      expect(rec({ ...ITEM, kind, short: 'y'.repeat(33) })).toEqual(BAD);
      expect(rec({ ...ITEM, kind, title: 'x'.repeat(160), short: 'y'.repeat(32) })).toMatchObject({ kind: 'record' });
    }
    expect(rec({ ...ITEM, kind: 'anniv', title: 'x'.repeat(161) })).toMatchObject({ kind: 'record' });
  });

  it('其余几支', () => {
    expect(outcomeOf({ fallback: true, reason: 'feature_off' })).toEqual({ kind: 'fallback', reason: 'feature_off' });
    expect(outcomeOf({ consent_required: true })).toEqual({ kind: 'consent_required' });
    expect(outcomeOf({ quota_out: true, quota_left: 0 })).toEqual({ kind: 'quota_out' });
    expect(outcomeOf({ ai_failed: true, reason: 'timeout' })).toEqual({ kind: 'ai_failed', reason: 'timeout' });
  });
});
