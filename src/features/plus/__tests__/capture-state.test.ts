// 记录状态机（data/capture-state.ts；架构 5.9、5.11 第 4 点；B3 任务单 FA-1）
import { describe, expect, it } from 'vitest';
import { captureStep, isFinal, type CaptureEvent, type CaptureStatus } from '../data/capture-state.ts';

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
  it('取消：进行中的变 cancelled；结果和 idle 不变；确认行没选回到 idle', () => {
    expect(captureStep('recording', { type: 'cancel' })).toBe('cancelled');
    expect(captureStep('organizing', { type: 'cancel' })).toBe('cancelled');
    expect(captureStep('saved', { type: 'cancel' })).toBe('saved');
    expect(captureStep('idle', { type: 'cancel' })).toBe('idle');
    expect(captureStep('confirming', { type: 'cancel' })).toBe('idle');
  });
  it('不合法的转移原样返回（晚到的回调、连点）', () => {
    expect(captureStep('saved', { type: 'done', status: 'ai_failed' })).toBe('saved');
    expect(captureStep('idle', { type: 'stop' })).toBe('idle');
    expect(captureStep('recording', { type: 'organize' })).toBe('recording');
    expect(captureStep('cancelled', { type: 'retry' })).toBe('cancelled');
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
