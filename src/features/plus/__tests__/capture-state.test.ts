// 记录状态机（data/capture-state.ts；架构 5.9、5.11 第 4 点；B3 任务单 FA-1）
import { describe, expect, it } from 'vitest';
import { captureStep, isFinal, viewStep, type CaptureEvent, type CaptureStatus, type CaptureView } from '../data/capture-state.ts';

const walk = (events: CaptureEvent[], from: CaptureStatus = 'idle'): CaptureStatus => events.reduce(captureStep, from);

describe('captureStep', () => {
  it('录音路：preparing → recording → uploading → organizing → saved（直传，没有编码那一步）', () => {
    expect(walk([{ type: 'prepare' }, { type: 'start', path: 'rec' }, { type: 'stop' }])).toBe('uploading');
    expect(walk([{ type: 'prepare' }, { type: 'start', path: 'rec' }, { type: 'stop' }, { type: 'organize' }, { type: 'done', status: 'saved' }])).toBe('saved');
  });
  it('兜底路：listening → organizing；没听清 → no_speech', () => {
    expect(walk([{ type: 'prepare' }, { type: 'start', path: 'speech' }, { type: 'organize' }])).toBe('organizing');
    expect(walk([{ type: 'prepare' }, { type: 'start', path: 'speech' }, { type: 'no_speech' }])).toBe('no_speech');
  });
  it('打字路：idle → organizing → confirming → organizing → saved_rule', () => {
    expect(walk([{ type: 'organize' }, { type: 'need_confirm' }, { type: 'confirmed' }, { type: 'done', status: 'saved_rule' }])).toBe('saved_rule');
  });
  it('ai_failed 可以重试回到 uploading', () => {
    const failed = walk([{ type: 'prepare' }, { type: 'start', path: 'rec' }, { type: 'stop' }, { type: 'done', status: 'ai_failed' }]);
    expect(failed).toBe('ai_failed');
    expect(captureStep(failed, { type: 'retry' })).toBe('uploading');
  });
  it('cancel 只管确认行没选（回到 idle）；别的状态原样（录音中丢掉走 reset）', () => {
    expect(captureStep('recording', { type: 'cancel' })).toBe('recording');
    expect(captureStep('organizing', { type: 'cancel' })).toBe('organizing');
    expect(captureStep('saved', { type: 'cancel' })).toBe('saved');
    expect(captureStep('idle', { type: 'cancel' })).toBe('idle');
    expect(captureStep('confirming', { type: 'cancel' })).toBe('idle');
  });
  it('不合法的转移原样返回（晚到的回调、连点）', () => {
    expect(captureStep('saved', { type: 'done', status: 'ai_failed' })).toBe('saved');
    expect(captureStep('idle', { type: 'stop' })).toBe('idle');
    expect(captureStep('recording', { type: 'organize' })).toBe('recording');
    expect(captureStep('no_speech', { type: 'retry' })).toBe('no_speech');
  });
  it('reset 一律回 idle', () => {
    expect(captureStep('ai_failed', { type: 'reset' })).toBe('idle');
  });
});

describe('辅助判断', () => {
  it('isFinal', () => {
    expect(isFinal('offline_saved')).toBe(true);
    expect(isFinal('organizing')).toBe(false);
  });
});

describe('viewStep：锁定、区、说明卡、提示和状态一起走（FA-3 第二轮复查项）', () => {
  type V = CaptureView<string>;
  const V0: V = { status: 'idle', capturing: false, locked: false, zone: null, card: null, note: null };
  const run = (...es: Parameters<typeof viewStep<string, V>>[1][]): V => es.reduce<V>((v, e) => viewStep(v, e), V0);

  it('锁定、区只在录着时有；录完（停、丢掉、出错）自动清掉', () => {
    expect(run({ type: 'lock' }), '没在录：拦下').toBe(V0);
    expect(run({ type: 'zone', zone: 'cancel' })).toBe(V0);
    const rec = run({ type: 'prepare' }, { type: 'start', path: 'rec' }, { type: 'zone', zone: 'lock' }, { type: 'lock' });
    expect(rec).toMatchObject({ status: 'recording', capturing: true, locked: true, zone: null });
    expect(viewStep(rec, { type: 'stop' })).toMatchObject({ status: 'uploading', capturing: false, locked: false, zone: null });
    expect(viewStep(rec, { type: 'reset' })).toMatchObject({ status: 'idle', locked: false });
  });

  it('说明卡只在 idle 出，出了就收起提示；进了录音说明卡收起', () => {
    const noted = run({ type: 'note', note: 'offline' });
    expect(viewStep(noted, { type: 'card', card: 'ask' })).toMatchObject({ card: 'ask', note: null });
    const busy = run({ type: 'prepare' });
    expect(viewStep(busy, { type: 'card', card: 'denied' }), '录着时不出卡').toBe(busy);
    expect(viewStep(run({ type: 'card', card: 'ask' }), { type: 'prepare' })).toMatchObject({ status: 'preparing', card: null });
  });

  it('提示只在 idle、结局、确认行时出；进了录音、上传收起', () => {
    const up = run({ type: 'prepare' }, { type: 'start', path: 'rec' }, { type: 'stop' });
    expect(viewStep(up, { type: 'note', note: 'x' }), '上传中不出提示').toBe(up);
    const failed = viewStep(up, { type: 'done', status: 'ai_failed' });
    const shown = viewStep(failed, { type: 'note', note: 'ai_failed' });
    expect(shown.note).toBe('ai_failed');
    expect(viewStep(shown, { type: 'retry' })).toMatchObject({ status: 'uploading', note: null });
    expect(viewStep(run({ type: 'note', note: 'nothing' }), { type: 'prepare' }).note).toBeNull();
  });
});
