// 告知页分包挂住（独立评审 11-17 第 14 条）：noticeState 说 first，但告知页的容器 ConsentRoute 那一块一直下载不回来——
// 关口按同一个起点的剩余时限放行（和 noticeState 超时一样），不一直空白；放行只一次。分包正常回来时照样显示告知页（consent-wiring.test.tsx）
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsentApi } from '../data/consent-api.ts';
import ConsentGate from '../ui/ConsentGate.tsx';

// 告知页容器那一块：永远下载不回来
vi.mock('../ui/ConsentRoute.tsx', () => new Promise(() => undefined));

const api: ConsentApi = {
  record: vi.fn(async () => ({ ok: true as const, value: undefined })),
  noticeState: vi.fn(async () => ({ ok: true as const, value: 'first' as const })),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('告知页分包挂住', () => {
  it('到关口上限还没下载好：放行（只一次），不显示告知页', async () => {
    vi.useFakeTimers();
    const onPass = vi.fn();
    await act(async () => {
      render(<ConsentGate api={api} wiring={{ enableAi: vi.fn(), leave: vi.fn() }} onPass={onPass} limitMs={3000} />);
    });
    expect(api.noticeState).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(onPass).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(onPass).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-step="consent"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onPass).toHaveBeenCalledOnce();
  });

  it('给了 startedAt：分包等的时间也从那一刻算起，已经过了上限就当场放行', async () => {
    vi.useFakeTimers();
    const onPass = vi.fn();
    await act(async () => {
      render(<ConsentGate api={api} wiring={{ enableAi: vi.fn(), leave: vi.fn() }} onPass={onPass} limitMs={3000} startedAt={Date.now() - 2500} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onPass).toHaveBeenCalledOnce();
  });
});
