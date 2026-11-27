// 按住“＋”的“离按下多少毫秒”日志（hooks/voice-sink.ts 的 logSinceDown，独立评审 11-25 第 7 条）：
// 按住时记 voice hold <段>=<ms>；录完（capturing 由 true 变 false）、录音那一套卸下以后按下时刻清掉，再记就不出（原来留着上一次的，记一个很大的数）
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as RunLogApi from '../../../platform/run-log-api.ts';
import type { VoiceSession } from '../data/voice-session.ts';

const { rlog } = vi.hoisted(() => ({ rlog: vi.fn() }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<typeof RunLogApi>()), rlog }));
const { hold, logSinceDown, useVoiceSink } = await import('../hooks/voice-sink.ts');

/** 只有 useVoiceSink 用到的几样：view、subscribe 和手势转过来的动作 */
function fakeSession() {
  const st = { capturing: false, locked: false, status: 'idle' };
  const subs = new Set<() => void>();
  const s = {
    view: () => st,
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    down: vi.fn(),
    start: vi.fn(() => true),
    zone: vi.fn(),
    lock: vi.fn(),
    finish: vi.fn(),
    discard: vi.fn(),
  };
  const set = (p: Partial<typeof st>): void => {
    Object.assign(st, p);
    for (const f of subs) f();
  };
  return { s: s as unknown as VoiceSession, set };
}
const zone = { current: null };
const press = (): void => {
  const el = document.createElement('button');
  document.body.appendChild(el);
  hold.onStart({ button: 0, isPrimary: true, currentTarget: el, pointerId: 1, clientX: 0, clientY: 0 } as unknown as Parameters<typeof hold.onStart>[0]);
};
const lines = (): string[] => rlog.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('voice hold panel'));

afterEach(() => {
  cleanup();
  hold.reset();
  rlog.mockClear();
  document.body.replaceChildren();
});

describe('logSinceDown', () => {
  it('没按过不记', () => {
    logSinceDown('panel');
    expect(lines()).toEqual([]);
  });

  it('按住时记 voice hold panel=<ms>；录完（capturing 变 false）以后不再记', () => {
    const { s, set } = fakeSession();
    renderHook(() => useVoiceSink(s, zone, zone));
    press();
    set({ capturing: true, status: 'recording' });
    logSinceDown('panel');
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^voice hold panel=\d+$/);
    set({ capturing: false, status: 'idle' });
    logSinceDown('panel');
    expect(lines()).toHaveLength(1);
  });

  it('录音那一套卸下以后也清掉', () => {
    const { s } = fakeSession();
    const v = renderHook(() => useVoiceSink(s, zone, zone));
    press();
    v.unmount();
    logSinceDown('panel');
    expect(lines()).toEqual([]);
  });
});
