// R-68 探测页（B3 FA-0）：录音走正式录音器 platform/recorder.ts，桩用 recorder-fake.ts 的假 MediaRecorder 和假麦克风
// Q-5“句首被吃”：按下后、start 事件之前按钮是 starting（不说 Recording），start 事件来了才是 recording；starting 时松手不卡住
// 安全审建议 ①：录音中组件卸载或 pagehide，马上停录音、关麦克风，这一段不上传
// 代码审 M1（连按竞态）、S1（卸载取消上传）、S2（到上限的提示）、S3（接近 600 KB 的提示）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AUDIO_BITS_PER_SECOND } from '../../../shared/schema/ai.ts';
import { allClosed, FakeRecorder, flush, mic, named, rec0, recorderEnv, type Mic } from '../../platform/__tests__/recorder-fake.ts';
import type * as Probe from '../../platform/voice-probe.ts';
import { PROBE_MAX_MS } from '../../platform/voice-probe.ts';

const upload = vi.fn();
vi.mock('../../platform/voice-probe.ts', async (orig) => ({
  ...(await orig<typeof Probe>()),
  uploadProbe: (...a: unknown[]) => upload(...a),
}));
const { default: VoiceProbe } = await import('../dev/VoiceProbe.tsx');

const log = recorderEnv();
let m: Mic;
beforeEach(() => {
  // 结果留底（R-382）会把上一条用例的结果带进来：每条用例从空的开始
  localStorage.clear();
  // jsdom 没有 setPointerCapture
  HTMLElement.prototype.setPointerCapture = vi.fn();
  m = mic();
  upload.mockResolvedValue({ status: 200, result: 'ok', transcript: 'x', client_ms: 1 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const hold = (): HTMLElement => screen.getByTestId('probe-hold');
const step = async (fn: () => void): Promise<void> =>
  act(async () => {
    fn();
    await flush();
  });
const press = (): Promise<void> => step(() => fireEvent.pointerDown(hold(), { pointerId: 1 }));
const release = (): Promise<void> => step(() => fireEvent.pointerUp(hold(), { pointerId: 1 }));
/** 录音器发 start 事件（真正开始收音） */
const started = (r: FakeRecorder = rec0()): Promise<void> => step(() => r.fireStart());

async function startHolding(): Promise<void> {
  render(<VoiceProbe />);
  await press();
  await started();
  expect(hold().getAttribute('data-recording')).toBe('1');
}

describe('Q-5：start 事件来了才算开录', () => {
  it('按下后、start 事件之前：starting，不显示 Recording；start 事件来了才显示 Recording', async () => {
    render(<VoiceProbe />);
    expect(hold().getAttribute('data-phase')).toBe('idle');
    await press();
    expect(hold().getAttribute('data-phase')).toBe('starting');
    expect(hold().getAttribute('data-recording')).toBe('0');
    expect(hold().textContent).toBe('Starting mic… wait');
    expect(hold().textContent).not.toMatch(/Recording/);
    // 录音器已经 start() 了，但 start 事件还没来：仍是 starting
    expect(rec0().state).toBe('recording');
    await step(() => vi.advanceTimersByTime(500));
    expect(hold().getAttribute('data-phase')).toBe('starting');
    await started();
    expect(hold().getAttribute('data-phase')).toBe('recording');
    expect(hold().getAttribute('data-recording')).toBe('1');
    expect(hold().textContent).toBe('Recording… speak now, release to upload');
  });

  it('参数和正式录音一致：码率 AI_AUDIO_BITS_PER_SECOND（48 kbps）', async () => {
    render(<VoiceProbe />);
    await press();
    expect(rec0().ctorArgs[1]).toEqual({ audioBitsPerSecond: AI_AUDIO_BITS_PER_SECOND });
    expect(AI_AUDIO_BITS_PER_SECOND).toBe(48_000);
  });

  it('每段显示按下到真正开录用了多少毫秒，运行日志记一行（只有数字）', async () => {
    render(<VoiceProbe />);
    await press();
    await step(() => vi.advanceTimersByTime(240));
    await started();
    expect(log.lines).toContain('probe mic_ready ms=240');
    await release();
    expect(screen.getByTestId('probe-results').textContent).toContain('mic ready +240 ms');
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('starting 时松手不卡住：取消、关麦克风、不上传，回到 idle 并提示；还能再按一次正常录', async () => {
    render(<VoiceProbe />);
    await press();
    await release();
    expect(hold().getAttribute('data-phase')).toBe('idle');
    expect(hold().textContent).toBe(`Hold to record (max ${PROBE_MAX_MS / 1000} s)`);
    expect(screen.getByRole('alert').textContent).toMatch(/^released before Recording showed/);
    expect(allClosed(m)).toBe(true);
    expect(rec0().stopCalls).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    // 迟到的 start 事件不会把页面又切回 recording
    await started();
    expect(hold().getAttribute('data-phase')).toBe('idle');
    expect(upload).not.toHaveBeenCalled();
    // 再按一次
    await press();
    expect(screen.queryByRole('alert')).toBeNull();
    await started(FakeRecorder.made[1]);
    expect(hold().getAttribute('data-phase')).toBe('recording');
    await release();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('还在等麦克风授权时松手：授权回来后马上关掉，按钮早已回到 idle', async () => {
    let grant: (s: MediaStream) => void = () => undefined;
    m.getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((r) => (grant = r)));
    render(<VoiceProbe />);
    await press();
    expect(hold().getAttribute('data-phase')).toBe('starting');
    await release();
    expect(hold().getAttribute('data-phase')).toBe('idle');
    await step(() => grant(m.stream));
    expect(allClosed(m)).toBe(true);
    expect(FakeRecorder.made).toHaveLength(0);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('录音中离开页面', () => {
  it('组件卸载：马上停录音、关麦克风，不上传', async () => {
    await startHolding();
    await step(() => cleanup());
    expect(rec0().stopCalls).toBe(1);
    expect(allClosed(m)).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starting 时卸载：同样关麦克风', async () => {
    render(<VoiceProbe />);
    await press();
    await step(() => cleanup());
    expect(allClosed(m)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pagehide：马上停、按钮回到没在录；之后松手也不上传', async () => {
    await startHolding();
    await step(() => window.dispatchEvent(new Event('pagehide')));
    expect(allClosed(m)).toBe(true);
    expect(hold().getAttribute('data-recording')).toBe('0');
    await release();
    expect(upload).not.toHaveBeenCalled();
  });

  it('没在录时卸载、pagehide 什么都不做', async () => {
    render(<VoiceProbe />);
    window.dispatchEvent(new Event('pagehide'));
    cleanup();
    expect(m.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('连按（代码审 M1）', () => {
  it('第一次还在等权限时松手、再按；第一次后来失败，不清掉第二次的状态和句柄', async () => {
    let fail1: (e: Error) => void = () => undefined;
    m.getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((_r, reject) => (fail1 = reject)));
    render(<VoiceProbe />);
    await press();
    await release();
    await press();
    expect(m.getUserMedia).toHaveBeenCalledTimes(2);
    await started();
    await step(() => fail1(named('NotAllowedError')));
    // 第二次照样在录、没报错
    expect(hold().getAttribute('data-recording')).toBe('1');
    expect(screen.queryByRole('alert')).toBeNull();
    // 第二次的句柄还在：卸载时能停掉第二次的麦克风
    await step(() => cleanup());
    expect(allClosed(m)).toBe(true);
    expect(rec0().stopCalls).toBe(1);
  });

  it('只按了一次、拿麦克风被拒：回到 idle 并显示原因', async () => {
    m.getUserMedia.mockImplementationOnce(async () => {
      throw named('NotAllowedError');
    });
    render(<VoiceProbe />);
    await press();
    expect(hold().getAttribute('data-phase')).toBe('idle');
    expect(screen.getByRole('alert').textContent).toBe('record failed: denied');
  });
});

describe('录音器自己停了（代码审 S2）', () => {
  it('到 50 秒上限：按钮改成已到上限，松手照样上传', async () => {
    render(<VoiceProbe />);
    await press();
    await started();
    await step(() => vi.advanceTimersByTime(PROBE_MAX_MS - 1));
    expect(hold().textContent).toBe('Recording… speak now, release to upload');
    await step(() => vi.advanceTimersByTime(1));
    expect(hold().getAttribute('data-capped')).toBe('1');
    expect(hold().textContent).toBe('Max 50 s reached, release to upload');
    expect(allClosed(m)).toBe(true);
    await release();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(hold().getAttribute('data-capped')).toBe('0');
  });

  it('没到上限就停了（麦克风被系统收走）：写“已停”，松手照样上传', async () => {
    render(<VoiceProbe />);
    await press();
    await started();
    await step(() => rec0().endNow());
    expect(hold().getAttribute('data-capped')).toBe('0');
    expect(hold().textContent).toBe('Recording stopped, release to upload');
    await release();
    expect(upload).toHaveBeenCalledTimes(2);
  });
});

describe('录音大小（代码审 S3）', () => {
  it.each([
    [500 * 1024, null],
    [560 * 1024, 'Close to the 600.0 KB server limit; above it the server replies 413'],
  ] as const)('%d B → %s', async (bytes, warn) => {
    render(<VoiceProbe />);
    await press();
    rec0().chunks = [new Blob([new Uint8Array(bytes)])];
    await started();
    await release();
    expect(screen.queryByTestId('probe-size-warn')?.textContent ?? null).toBe(warn);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('超过 600 KB：录音器不交出，提示 too_large，不上传', async () => {
    render(<VoiceProbe />);
    await press();
    rec0().chunks = [new Blob([new Uint8Array(610 * 1024)])];
    await started();
    await release();
    expect(screen.getByRole('alert').textContent).toBe('too_large: over 600.0 KB, not uploaded');
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('上传中卸载（代码审 S1）', () => {
  it('取消正在传的这一种，不再传第二种', async () => {
    let seen: AbortSignal | undefined;
    upload.mockImplementation((_b: Blob, _l: string, _m: string, _d: unknown, signal?: AbortSignal) => {
      seen = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ status: 0, error: 'cancelled', client_ms: 1 })));
    });
    await startHolding();
    await release();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(seen?.aborted).toBe(false);
    await step(() => cleanup());
    expect(seen?.aborted).toBe(true);
    await step(() => undefined);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
