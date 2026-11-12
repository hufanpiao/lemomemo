// 录音时的音量（platform/recorder.ts 的 level()；B3 FA-3 录音面板的声波）：第一次调才接音量计、只读不改录音、结束一起关；
// 没有 Web Audio 或接不上时返回 -1（面板画静止的声波），不影响录音
import { describe, expect, it, vi } from 'vitest';
import { mic, recorderEnv, recording } from './recorder-fake.ts';

const log = recorderEnv();

function audioCtx(sample: number) {
  const made: { closed: boolean; connected: boolean }[] = [];
  class Ctx {
    state = { closed: false, connected: false };
    constructor() {
      made.push(this.state);
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getByteTimeDomainData: (buf: Uint8Array) => buf.fill(sample),
      };
    }
    createMediaStreamSource() {
      return { connect: () => void (this.state.connected = true) };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      this.state.closed = true;
      return Promise.resolve();
    }
  }
  vi.stubGlobal('AudioContext', Ctx);
  return made;
}

describe('录音音量 level()', () => {
  it('第一次调才接音量计；安静 = 0，有声音 > 0；结束以后 -1，音量计关掉', async () => {
    mic();
    const made = audioCtx(128);
    const rec = await recording();
    expect(made, '开录时不接').toHaveLength(0);
    expect(rec.level()).toBe(0);
    expect(made).toHaveLength(1);
    expect(made[0]?.connected).toBe(true);
    expect(log.lines).toContain('rec meter on');
    await rec.stop();
    expect(rec.level()).toBe(-1);
    expect(made[0]?.closed).toBe(true);
  });

  it('有声音：按 RMS 算，限在 0～1', async () => {
    mic();
    audioCtx(200);
    const rec = await recording();
    const v = rec.level();
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('没有 Web Audio：-1，照样能录完', async () => {
    mic();
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const rec = await recording();
    expect(rec.level()).toBe(-1);
    expect(log.lines).toContain('rec meter off');
    const end = await rec.stop();
    expect(end.ok).toBe(true);
  });
});
