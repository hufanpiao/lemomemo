// R-68 探测页（B3 FA-0，安全审建议 ①）：录音中组件卸载或 pagehide，马上停录音、关麦克风，这一段不上传
// 代码审 M1（连按竞态）、S1（卸载取消上传）、S2（到上限的提示）、S3（接近 600 KB 的提示）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Probe from '../../platform/voice-probe.ts';

const cancel = vi.fn();
const stop = vi.fn(async () => ({ blob: new Blob([new Uint8Array([1])], { type: 'audio/webm' }), mime: 'audio/webm', ms: 100 }));
const upload = vi.fn();
const start = vi.fn();
vi.mock('../../platform/voice-probe.ts', async (orig) => ({
  ...(await orig<typeof Probe>()),
  startRecording: (...a: unknown[]) => start(...a),
  uploadProbe: (...a: unknown[]) => upload(...a),
  supportedTypes: () => [],
}));
const { default: VoiceProbe } = await import('../dev/VoiceProbe.tsx');

beforeEach(() => {
  // 结果留底（R-382）会把上一条用例的结果带进来：每条用例从空的开始
  localStorage.clear();
  // jsdom 没有 setPointerCapture
  HTMLElement.prototype.setPointerCapture = vi.fn();
  start.mockImplementation(async () => ({ stop, cancel }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function startHolding(): Promise<void> {
  render(<VoiceProbe />);
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId('probe-hold'), { pointerId: 1 });
    await Promise.resolve();
  });
  expect(screen.getByTestId('probe-hold').getAttribute('data-recording')).toBe('1');
}

describe('录音中离开页面', () => {
  it('组件卸载：马上 cancel，不 stop、不上传', async () => {
    await startHolding();
    await act(async () => {
      cleanup();
      await Promise.resolve();
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('pagehide：马上 cancel、按钮回到没在录；之后松手也不上传', async () => {
    await startHolding();
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('probe-hold').getAttribute('data-recording')).toBe('0');
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId('probe-hold'), { pointerId: 1 });
      await Promise.resolve();
    });
    expect(stop).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('没在录时卸载、pagehide 什么都不做', async () => {
    render(<VoiceProbe />);
    window.dispatchEvent(new Event('pagehide'));
    cleanup();
    expect(cancel).not.toHaveBeenCalled();
  });
});

const hold = (): HTMLElement => screen.getByTestId('probe-hold');
const press = async (): Promise<void> =>
  act(async () => {
    fireEvent.pointerDown(hold(), { pointerId: 1 });
    await Promise.resolve();
  });
const release = async (): Promise<void> =>
  act(async () => {
    fireEvent.pointerUp(hold(), { pointerId: 1 });
    await Promise.resolve();
  });

describe('连按（代码审 M1）', () => {
  it('第一次还在等权限时松手、再按；第一次后来失败，不清掉第二次的句柄', async () => {
    let fail1: (e: Error) => void = () => undefined;
    const cancel2 = vi.fn();
    start
      .mockImplementationOnce(
        () =>
          new Promise((_r, reject) => {
            fail1 = reject;
          }),
      )
      .mockImplementationOnce(async () => ({ stop, cancel: cancel2 }));
    render(<VoiceProbe />);
    await press();
    await release();
    await press();
    expect(start).toHaveBeenCalledTimes(2);
    await act(async () => {
      fail1(new DOMException('denied', 'NotAllowedError'));
      await Promise.resolve();
    });
    // 第二次照样在录、没报错
    expect(hold().getAttribute('data-recording')).toBe('1');
    expect(screen.queryByRole('alert')).toBeNull();
    // 第二次的句柄还在：卸载时能停掉第二次的麦克风
    await act(async () => {
      cleanup();
      await Promise.resolve();
    });
    expect(cancel2).toHaveBeenCalledTimes(1);
  });

  it('只按了一次、拿麦克风失败：回到没在录并显示原因', async () => {
    start.mockImplementationOnce(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    render(<VoiceProbe />);
    await press();
    expect(hold().getAttribute('data-recording')).toBe('0');
    expect(screen.getByRole('alert').textContent).toBe('NotAllowedError: denied');
  });
});

describe('到 50 秒上限（代码审 S2）', () => {
  it('录音器自己停了：按钮改成已到上限，松手照样上传', async () => {
    let onCap: () => void = () => undefined;
    start.mockImplementationOnce(async (_now: unknown, cb: () => void) => {
      onCap = cb;
      return { stop, cancel };
    });
    upload.mockResolvedValue({ status: 200, result: 'ok', transcript: 'x', client_ms: 1 });
    render(<VoiceProbe />);
    await press();
    expect(hold().textContent).toBe('Recording… release to upload');
    act(() => onCap());
    expect(hold().getAttribute('data-capped')).toBe('1');
    expect(hold().textContent).toBe('Max 50 s reached, release to upload');
    await release();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(hold().getAttribute('data-capped')).toBe('0');
  });
});

describe('录音大小（代码审 S3）', () => {
  const sized = (bytes: number) => async () => ({ blob: new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }), mime: 'audio/mp4', ms: 50_000 });
  it.each([
    [500 * 1024, null],
    [560 * 1024, 'Close to'],
    [610 * 1024, 'Over'],
  ] as const)('%d B → %s', async (bytes, word) => {
    stop.mockImplementationOnce(sized(bytes));
    upload.mockResolvedValue({ status: 200, result: 'ok', transcript: 'x', client_ms: 1 });
    render(<VoiceProbe />);
    await press();
    await release();
    const warn = screen.queryByTestId('probe-size-warn');
    if (word === null) expect(warn).toBeNull();
    else expect(warn?.textContent).toBe(`${word} the 600.0 KB server limit; above it the server replies 413`);
  });
});

describe('上传中卸载（代码审 S1）', () => {
  it('取消正在传的这一种，不再传第二种', async () => {
    let seen: AbortSignal | undefined;
    upload.mockImplementation((_b: Blob, _l: string, _m: string, _d: unknown, signal?: AbortSignal) => {
      seen = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ status: 0, error: 'cancelled', client_ms: 1 })));
    });
    render(<VoiceProbe />);
    await press();
    await release();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(seen?.aborted).toBe(false);
    await act(async () => {
      cleanup();
      await Promise.resolve();
    });
    expect(seen?.aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
