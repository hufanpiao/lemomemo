// 操作音效和震动（R-471，platform/feedback.ts + fx-api.ts）：开关关掉不响不震、录音中不出声不碰 audioSession、各种降级（没有 vibrate 走 iOS 系统开关、
// 都没有为 none、没有 AudioContext 不报错）、静音键也出声（audioSession 播前设 playback、播完改回）、运行日志节流、fx-api 装好前不做事
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
/** 建上下文、恢复的诊断行（fx audio new / resume）另收在 audioLogs，logs 只留音效那一行和 fx audio close */
const audioLogs: string[] = [];
vi.mock('../run-log-api.ts', () => ({ rlog: (l: string) => (/^fx audio (new|resume|idle)/.test(l) ? audioLogs : logs).push(l) }));

const { AUDIO_RESTORE_MS, FX_KEY, HAPTIC_MS, LOG_GAP_MS, fx, fxOnOf, hapticPath, resetFxForTest, startFx, tryHaptic } = await import('../feedback.ts');
const api = await import('../fx-api.ts');

interface Osc {
  freq: number[];
  ramps: number[];
}
let oscs: Osc[] = [];
let ctxMade = 0;
let ctxClosed = 0;
let ctxSuspended = 0;

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  constructor() {
    ctxMade += 1;
  }
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  suspend = vi.fn(() => {
    this.state = 'suspended';
    ctxSuspended += 1;
    return Promise.resolve();
  });
  close = vi.fn(() => {
    ctxClosed += 1;
    return Promise.resolve();
  });
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
  audioLogs.length = 0;
  oscs = [];
  ctxMade = 0;
  ctxClosed = 0;
  ctxSuspended = 0;
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
    // 诊断（11-18“放下最多只有 3 次提示音”）：记第几次建的、建出来什么状态
    expect(audioLogs[0]).toMatch(/^fx audio new n=\d+ state=/);
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

  it('整个 app 只建一个 AudioContext：放完 AUDIO_RESTORE_MS 后 suspend 不关，下次 resume 接着用（11-18“放下最多只有 3 次提示音”：原来每次 close 再 new）', async () => {
    vi.useFakeTimers();
    api.fx('done');
    api.fx('drop');
    api.fx('delete');
    expect(ctxMade).toBe(1);
    vi.advanceTimersByTime(120 + 50 + AUDIO_RESTORE_MS - 10);
    expect(ctxSuspended).toBe(0);
    vi.advanceTimersByTime(20);
    expect(ctxSuspended).toBe(1);
    expect(ctxClosed).toBe(0);
    for (let i = 0; i < 6; i++) {
      api.fx('drop');
      vi.advanceTimersByTime(2000);
    }
    expect(ctxMade, '放下 6 次还是同一个').toBe(1);
    expect(ctxClosed).toBe(0);
  });

  it('开始收音时 releaseFxAudio 彻底关掉（录音不再全是静音），之后出声再建一个', () => {
    api.fx('drop');
    api.releaseFxAudio();
    expect(ctxClosed).toBe(1);
    expect(logs).toContain('fx audio close');
    api.fx('drop');
    expect(ctxMade).toBe(2);
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
  it('没有 navigator.vibrate、支持 <input switch>（iOS 18）：不代点任何开关（11-18 iOS 26.6 真机代点不震），只记下“该震”交给手指下的真开关（takeBuzz）', () => {
    delete nav.vibrate;
    proto.switch = false;
    expect(hapticPath()).toBe('switch');
    const clicked: Event[] = [];
    const seen = (e: Event): void => void clicked.push(e);
    document.addEventListener('click', seen, true);
    api.fx('done');
    document.removeEventListener('click', seen, true);
    expect(clicked, '不代点').toHaveLength(0);
    expect(document.querySelectorAll('input[switch]')).toHaveLength(0);
    expect(api.takeBuzz(), '这一下该震').toBe(true);
    expect(api.takeBuzz(), '问完就清掉，一下只放一次').toBe(false);
    api.fx('lift');
    expect(api.takeBuzz(), '长按、拖动、下拉没有 click，不记（独立评审 11-19：拖完马上取消勾选不该震）').toBe(false);
    api.fx('delete');
    expect(api.takeBuzz(true), 'keep：问了不清').toBe(true);
    expect(api.takeBuzz()).toBe(true);
    expect(logs).toEqual(['fx done hap=switch snd=1', 'fx lift hap=switch snd=0', 'fx delete hap=switch snd=1']);
  });

  it('该震的记号过了 BUZZ_MS 就不算；“声音和触感”关着、走 vibrate 的不记', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    delete nav.vibrate;
    proto.switch = false;
    api.fx('done');
    now.mockReturnValue(10_000 + api.BUZZ_MS + 1);
    expect(api.takeBuzz()).toBe(false);
    now.mockRestore();
    rows = [{ id: '1', key: 'ui.fx', value: false }];
    api.fx('done');
    expect(api.takeBuzz(), '关着').toBe(false);
    rows = [];
    nav.vibrate = vi.fn(() => true);
    api.fx('done');
    expect(api.takeBuzz(), 'vibrate 已经自己震了').toBe(false);
  });

  it('诊断区试震动在 iOS 上也只记“该震”，由按钮里的 TapSwitch 出触感', () => {
    delete nav.vibrate;
    proto.switch = false;
    expect(tryHaptic()).toBe('switch');
    expect(api.takeBuzz()).toBe(true);
    expect(logs).toContain('fx try hap=switch');
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
    expect(logs.filter((l) => l !== 'fx audio close')).toHaveLength(3);
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
