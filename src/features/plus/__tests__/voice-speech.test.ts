// 手机自带识别这一路的生命周期（data/voice-speech.ts；B3 FA-3）：按下先开、按满接手、接手前已开始 / 已结束要补上、
// 没按满关掉、只有接手的那次报结果、60 秒封顶
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechEnd } from '../../../platform/speech.ts';
import { REC_MAX_MS } from '../data/record-logic.ts';
import { createSpeechRoute, type SpeechHost } from '../data/voice-speech.ts';

const fx = vi.hoisted(() => ({
  runs: [] as { lang: string; start(): void; end(r: unknown): void; stopped: boolean; cancelled: boolean }[],
  supported: true,
}));
vi.mock('../../../platform/speech.ts', () => ({
  speechSupported: () => fx.supported,
  startSpeech: (lang: string, h: { onStart(): void; onEnd(r: unknown): void }) => {
    const run = { lang, start: () => h.onStart(), end: (r: unknown) => h.onEnd(r), stopped: false, cancelled: false };
    fx.runs.push(run);
    return {
      ok: true,
      session: {
        stop: () => {
          run.stopped = true;
          h.onEnd({ ok: true, text: '买牛奶' });
        },
        cancel: () => {
          run.cancelled = true;
        },
      },
    };
  },
}));

function host() {
  const calls: string[] = [];
  const h: SpeechHost = {
    started: () => void calls.push('started'),
    ended: (r: SpeechEnd) => void calls.push(`ended ${r.ok ? r.text : r.fail}`),
    cap: () => void calls.push('cap'),
  };
  return { calls, route: createSpeechRoute(() => h, () => 1000) };
}

beforeEach(() => {
  fx.runs = [];
  fx.supported = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('手机自带识别这一路', () => {
  it('按下先开（按界面语言），接手前已经开始收音：接手时补报 started', () => {
    const { calls, route } = host();
    route.prime('ko-KR');
    expect(fx.runs).toHaveLength(1);
    expect(fx.runs[0]?.lang).toBe('ko-KR');
    fx.runs[0]?.start();
    expect(calls, '没接手不报').toEqual([]);
    expect(route.take('ko-KR')).toBe(true);
    expect(fx.runs, '接手先开的那次，不再开').toHaveLength(1);
    expect(calls).toEqual(['started']);
  });

  it('接手前就结束了：接手时补报结果', () => {
    const { calls, route } = host();
    route.prime('zh-CN');
    fx.runs[0]?.end({ ok: false, fail: 'network' });
    route.take('zh-CN');
    expect(calls).toEqual(['ended network']);
  });

  it('没按满（drop）：关掉先开的那次，之后它的结果不报', () => {
    const { calls, route } = host();
    route.prime('zh-CN');
    route.drop();
    expect(fx.runs[0]?.cancelled).toBe(true);
    fx.runs[0]?.end({ ok: true, text: 'x' });
    expect(calls).toEqual([]);
  });

  it('没有先开的：接手时当场开；松手 stop 后结果报回来', () => {
    const { calls, route } = host();
    expect(route.take('zh-CN')).toBe(true);
    fx.runs[0]?.start();
    route.stop();
    expect(calls).toEqual(['started', 'ended 买牛奶']);
  });

  it('不支持：接手返回 false', () => {
    fx.supported = false;
    const { route } = host();
    expect(route.take('zh-CN')).toBe(false);
  });

  it('cancel：接手的和先开的都关，结果不报', () => {
    const { calls, route } = host();
    route.take('zh-CN');
    route.prime('zh-CN');
    route.cancel();
    expect(fx.runs.every((r) => r.cancelled)).toBe(true);
    fx.runs[0]?.end({ ok: true, text: 'x' });
    expect(calls).toEqual([]);
  });

  it('开始收音满 60 秒：报 cap', () => {
    vi.useFakeTimers();
    const { calls, route } = host();
    route.take('zh-CN');
    fx.runs[0]?.start();
    vi.advanceTimersByTime(REC_MAX_MS - 1);
    expect(calls).toEqual(['started']);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['started', 'cap']);
  });
});
