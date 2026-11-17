// 操作音效和震动（R-471，platform/feedback.ts + fx-api.ts）：开关关掉不响不震、录音中不出声不碰 audioSession、各种降级（没有 vibrate 走 iOS 系统开关、
// 都没有为 none、没有 AudioContext 不报错）、静音键也出声（audioSession 播前设 playback、播完改回）、运行日志节流、fx-api 装好前不做事
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('../run-log-api.ts', () => ({ rlog: (l: string) => logs.push(l) }));

const { AUDIO_RESTORE_MS, FX_KEY, HAPTIC_MS, LOG_GAP_MS, fx, fxOnOf, hapticPath, resetFxForTest, startFx, tryHaptic } = await import('../feedback.ts');
const api = await import('../fx-api.ts');

interface Osc {
  freq: number[];
  ramps: number[];
}
let oscs: Osc[] = [];
let ctxMade = 0;

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  constructor() {
    ctxMade += 1;
  }
  resume = vi.fn(() => Promise.resolve());
  createGain() {
    return { gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
  }
  createBiquadFilter() {
    return { type: '', frequency: { value: 0 }, connect: vi.fn() };
  }
  createOscillator() {
    const o: Osc = { freq: [], ramps: [] };
    oscs.push(o);
    return {
      type: '',
      frequency: { setValueAtTime: (f: number) => o.freq.push(f), exponentialRampToValueAtTime: (f: number) => o.ramps.push(f) },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
}

const g = globalThis as unknown as { AudioContext?: unknown };
const nav = navigator as unknown as { vibrate?: unknown; audioSession?: { type: string } };
const proto = HTMLInputElement.prototype as unknown as { switch?: boolean };
let rows: Array<{ id: string; key: string; value: unknown }> = [];
const settings = { getSnapshot: () => rows };

beforeEach(() => {
  logs.length = 0;
  oscs = [];
  ctxMade = 0;
  rows = [];
  g.AudioContext = FakeAudioContext;
  nav.vibrate = vi.fn(() => true);
  resetFxForTest();
  startFx(settings);
});

afterEach(() => {
  vi.useRealTimers();
  delete g.AudioContext;
  delete nav.vibrate;
  delete nav.audioSession;
  delete proto.switch;
  api.setFxMicBusy(() => false);
  resetFxForTest();
});

describe('开关（settings 的 ui.fx）', () => {
  it('没设过、不是 false 都算开；false、软删的行不算', () => {
    expect(FX_KEY).toBe('ui.fx');
    expect(fxOnOf([])).toBe(true);
    expect(fxOnOf([{ key: 'ui.fx', value: true }])).toBe(true);
    expect(fxOnOf([{ key: 'ui.fx', value: false }])).toBe(false);
    expect(fxOnOf([{ key: 'ui.fx', value: false, deleted_at: '2026-11-17' }])).toBe(true);
    expect(fxOnOf([{ key: 'ui.fx', value: false, undone: true }])).toBe(true);
  });

  it('关掉：不响、不震、不建 AudioContext，日志 snd=off', () => {
    rows = [{ id: '1', key: 'ui.fx', value: false }];
    api.fx('done');
    expect(nav.vibrate).not.toHaveBeenCalled();
    expect(ctxMade).toBe(0);
    expect(logs).toEqual(['fx done hap=- snd=off']);
  });
});

describe('定稿的音和震', () => {
  it('勾完成：震一下（vibrate 12ms）+ 上行双音 784、1175Hz', () => {
    api.fx('done');
    expect(nav.vibrate).toHaveBeenCalledWith(HAPTIC_MS);
    expect(HAPTIC_MS).toBe(12);
    expect(oscs.map((o) => o.freq[0])).toEqual([784, 1175]);
    expect(logs).toEqual(['fx done hap=vibrate snd=1']);
  });

  it('拖动放下：正弦 300→180Hz；删除：620→310Hz', () => {
    api.fx('drop');
    api.fx('delete');
    expect(oscs.map((o) => [o.freq[0], o.ramps[0]])).toEqual([
      [300, 180],
      [620, 310],
    ]);
    expect(nav.vibrate).toHaveBeenCalledTimes(2);
  });

  it('拖起、下拉过门槛：只震不响（不建 AudioContext）', () => {
    api.fx('lift');
    api.fx('pull');
    expect(nav.vibrate).toHaveBeenCalledTimes(2);
    expect(ctxMade).toBe(0);
    expect(logs).toEqual(['fx lift hap=vibrate snd=0', 'fx pull hap=vibrate snd=0']);
  });

  it('AudioContext 只建一个、一直复用', () => {
    api.fx('done');
    api.fx('drop');
    api.fx('delete');
    expect(ctxMade).toBe(1);
  });
});

describe('录音、语音输入进行中', () => {
  it('不出声、不建 AudioContext、不碰 audioSession；震动照常', () => {
    nav.audioSession = { type: 'auto' };
    api.setFxMicBusy(() => true);
    api.fx('done');
    expect(ctxMade).toBe(0);
    expect(nav.audioSession.type).toBe('auto');
    expect(nav.vibrate).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['fx done hap=vibrate snd=mic']);
  });
});

describe('静音键打开也出声（audioSession）', () => {
  it('播之前设成 playback，AUDIO_RESTORE_MS 后改回原来的类型；连着播只在最后一次之后改回', () => {
    vi.useFakeTimers();
    nav.audioSession = { type: 'auto' };
    api.fx('done');
    expect(nav.audioSession.type).toBe('playback');
    vi.advanceTimersByTime(AUDIO_RESTORE_MS - 10);
    api.fx('delete');
    vi.advanceTimersByTime(AUDIO_RESTORE_MS - 10);
    expect(nav.audioSession.type).toBe('playback');
    vi.advanceTimersByTime(20);
    expect(nav.audioSession.type).toBe('auto');
  });

  it('改回之前开始录音了：不改回（录音那边的类型不归这里管）', () => {
    vi.useFakeTimers();
    nav.audioSession = { type: 'auto' };
    let busy = false;
    api.setFxMicBusy(() => busy);
    api.fx('done');
    busy = true;
    vi.advanceTimersByTime(AUDIO_RESTORE_MS);
    expect(nav.audioSession.type).toBe('playback');
  });

  it('没有 audioSession（Android、电脑）：照样播', () => {
    api.fx('done');
    expect(oscs).toHaveLength(2);
  });
});

describe('降级', () => {
  it('没有 navigator.vibrate、支持 <input switch>（iOS 18）：点藏起来的系统开关的 label', () => {
    delete nav.vibrate;
    proto.switch = false;
    expect(hapticPath()).toBe('switch');
    api.fx('lift');
    const input = document.querySelector<HTMLInputElement>('label[aria-hidden="true"] > input[type="checkbox"][switch]');
    expect(input, '藏起来的系统开关挂上了').not.toBeNull();
    expect(input?.checked, 'label.click() 点到了开关').toBe(true);
    expect(input?.tabIndex).toBe(-1);
    api.fx('pull');
    expect(input?.checked).toBe(false);
    expect(document.querySelectorAll('input[switch]')).toHaveLength(1);
    expect(logs).toEqual(['fx lift hap=switch snd=0', 'fx pull hap=switch snd=0']);
  });

  it('两样都没有：hap=none，不报错', () => {
    delete nav.vibrate;
    expect(hapticPath()).toBe('none');
    expect(() => api.fx('done')).not.toThrow();
    expect(logs).toEqual(['fx done hap=none snd=1']);
  });

  it('没有 AudioContext：snd=0，不报错；vibrate 抛错也不要紧', () => {
    delete g.AudioContext;
    nav.vibrate = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(() => api.fx('done')).not.toThrow();
    expect(logs).toEqual(['fx done hap=vibrate snd=0']);
  });
});

describe('运行日志、fx-api、试震动', () => {
  it('同一种类 LOG_GAP_MS 内只记一行；不同种类各记各的', () => {
    vi.useFakeTimers();
    api.fx('done');
    api.fx('done');
    api.fx('drop');
    expect(logs).toEqual(['fx done hap=vibrate snd=1', 'fx drop hap=vibrate snd=1']);
    vi.advanceTimersByTime(LOG_GAP_MS);
    api.fx('done');
    expect(logs).toHaveLength(3);
  });

  it('fx-api：实现还没装上时调 fx 什么都不做', () => {
    resetFxForTest();
    api.fx('done');
    expect(nav.vibrate).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    startFx(settings);
    api.fx('done');
    expect(nav.vibrate).toHaveBeenCalledTimes(1);
  });

  it('试震动：不看开关，返回并记下走的哪条路', () => {
    rows = [{ id: '1', key: 'ui.fx', value: false }];
    expect(tryHaptic()).toBe('vibrate');
    expect(nav.vibrate).toHaveBeenCalledWith(HAPTIC_MS);
    expect(logs).toEqual(['fx try hap=vibrate']);
    fx('lift');
    expect(nav.vibrate).toHaveBeenCalledTimes(1);
  });
});
