// 手机自带识别这一路的生命周期（data/voice-speech.ts；B3 FA-3）：按下先开、按满接手、接手前已开始 / 已结束要补上、
// 没按满关掉、只有接手的那次报结果、60 秒封顶；中途的字：接手前认出的补上、只报接手的那次；重开（cont）整段计时和 60 秒接着算
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechEnd } from '../../../platform/speech.ts';
import { REC_MAX_MS } from '../data/record-logic.ts';
import { createSpeechRoute, type SpeechHost } from '../data/voice-speech.ts';

const fx = vi.hoisted(() => ({
  runs: [] as { lang: string; start(): void; end(r: unknown): void; text?: ((t: string) => void) | undefined; stopped: boolean; cancelled: boolean }[],
  supported: true,
}));
vi.mock('../../../platform/speech.ts', () => ({
  speechSupported: () => fx.supported,
  startSpeech: (lang: string, h: { onStart(): void; onEnd(r: unknown): void; onText?(t: string): void }) => {
    const run = { lang, start: () => h.onStart(), end: (r: unknown) => h.onEnd(r), text: h.onText, stopped: false, cancelled: false };
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
    text: () => undefined,
  };
  return { calls, route: createSpeechRoute(h, () => 1000) };
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

  it('中途的字：接手前认出的接手时补上，之后逐次报；先开又关掉的不报', () => {
    const said: string[] = [];
    const route = createSpeechRoute({ started: () => undefined, ended: () => undefined, cap: () => undefined, text: (t) => void said.push(t) }, () => 1000);
    route.prime('zh-CN');
    fx.runs[0]?.text?.('买');
    expect(said, '没接手不报').toEqual([]);
    route.take('zh-CN');
    expect(said).toEqual(['买']);
    fx.runs[0]?.start();
    fx.runs[0]?.text?.('买牛奶');
    expect(said).toEqual(['买', '买牛奶']);
    route.prime('zh-CN');
    fx.runs[1]?.text?.('别的');
    route.drop();
    expect(said).toEqual(['买', '买牛奶']);
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

  it('手指还按着的重开（take cont）：整段计时和 60 秒上限接着算，不从 0 重来（语音整块评审第 5 条）；done 停表', () => {
    vi.useFakeTimers();
    let t = 1000;
    const calls: string[] = [];
    const route = createSpeechRoute({ started: () => undefined, ended: () => undefined, cap: () => void calls.push('cap'), text: () => undefined }, () => t);
    route.take('zh-CN');
    fx.runs[0]?.start();
    t += 20_000;
    vi.advanceTimersByTime(20_000);
    route.take('zh-CN', true);
    fx.runs[1]?.start();
    expect(route.elapsed()).toBe(20_000);
    t += 40_000;
    vi.advanceTimersByTime(REC_MAX_MS - 20_000);
    expect(calls, '整段满 60 秒').toEqual(['cap']);
    route.take('zh-CN');
    expect(route.elapsed(), '新开一段从 0 算').toBe(0);
    fx.runs[2]?.start();
    route.done();
    vi.advanceTimersByTime(REC_MAX_MS);
    expect(calls, 'done 以后不再报').toEqual(['cap']);
  });
});
