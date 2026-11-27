// 长帧计数（platform/jank-watch.ts）：有 >50ms 的帧才记、按周期汇总、记最长那一帧在哪页、切后台停、停止后不再记
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JANK_PERIOD_MS, watchJank } from '../jank-watch.ts';

/** 手动出帧：frame 收下回调，step(ms) 把时钟往前拨 ms 再出一帧 */
function fakeFrames() {
  let cb: (() => void) | null = null;
  return {
    frame: (f: () => void) => {
      cb = f;
    },
    step(ms: number) {
      vi.advanceTimersByTime(ms);
      const f = cb;
      cb = null;
      f?.();
    },
    /** 按 16ms 一帧连着出 ms 那么久（真浏览器前台每帧都出，周期定时器在这中间到点） */
    run(ms: number) {
      for (let t = 0; t < ms; t += 16) this.step(16);
    },
    pending: () => cb !== null,
  };
}

const vis = (v: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => {
  vi.useRealTimers();
  vis('visible');
});

describe('watchJank', () => {
  it('周期里有长帧才记一行：次数、最长、那一帧在哪页；没有长帧不记', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    location.hash = '#/notes';
    const f = fakeFrames();
    const lines: string[] = [];
    const stop = watchJank(document, f.frame, (l) => lines.push(l));
    for (let i = 0; i < 10; i++) f.step(16);
    f.step(120);
    f.step(16);
    f.step(70);
    f.run(JANK_PERIOD_MS);
    expect(lines).toEqual(['jank n50=2 max=120 route=notes']);
    f.run(JANK_PERIOD_MS);
    expect(lines).toHaveLength(1);
    stop();
  });

  it('切后台停（不算后台那一段），回来重开；停止以后不再记、不再要帧', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const f = fakeFrames();
    const lines: string[] = [];
    const stop = watchJank(document, f.frame, (l) => lines.push(l));
    f.step(16);
    vis('hidden');
    f.step(5000);
    vis('visible');
    f.run(JANK_PERIOD_MS);
    expect(lines).toEqual([]);
    stop();
    f.step(200);
    expect(f.pending()).toBe(false);
    vi.advanceTimersByTime(JANK_PERIOD_MS);
    expect(lines).toEqual([]);
  });
});
