// useDoneFlow 子任务自动完成那条路的竞态（主持人 11-17 复审必改 B）：先勾主待办，停留（HOLD_MS）期间又勾完最后一项子任务——
// plan 不能盖掉正在走的那一轮（方框照旧勾上、代号不变），result 不能把这一行从 linger 里拿掉；到点照常收起、出撤销条，收完才离开
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '../../hooks/useListActions.ts';
import { HOLD_MS, OUT_MS, useDoneFlow, useLinger } from '../useDoneFlow.ts';

type Acts = Parameters<typeof useDoneFlow>[0];

function setup() {
  const show = vi.fn();
  const acts = {
    g: { toast: null, show, dismiss: vi.fn(), block: vi.fn() },
    isRo: () => false,
    tick: vi.fn((): Promise<ActionResult> => Promise.resolve('ok')),
    shown: (_id: string, done: boolean) => done,
    report: vi.fn(),
  } as unknown as Acts;
  const hold = vi.fn();
  const h = renderHook(() => {
    const lg = useLinger();
    return { lg, f: useDoneFlow(acts, lg, hold, { done: '已完成' }, 'x') };
  });
  return { h, show, hold };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('先勾主待办、停留期间又勾完最后一项子任务', () => {
  it('plan 不盖掉正在走的一轮，result 不拿掉这一行；到点照常收起、出撤销条', async () => {
    const { h, show, hold } = setup();
    await act(async () => h.result.current.f.check('a', true));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // 勾最后一项：页面算出“会自动完成”（数据里主待办还没完成），写完回来主待办已经是完成的（auto 为 null）
    act(() => h.result.current.f.plan('a', true));
    expect(h.result.current.f.shown('a', false)).toBe(true);
    expect(hold).not.toHaveBeenCalled();
    act(() => h.result.current.f.result('a', { res: 'ok', auto: null, undo: () => Promise.resolve('ok'), message: '全部完成' }));
    expect(h.result.current.lg.ids.has('a')).toBe(true);
    expect(h.result.current.f.shown('a', false)).toBe(true);
    // 停够 HOLD_MS：照常收起、出撤销条
    await act(async () => {
      vi.advanceTimersByTime(HOLD_MS - 300);
    });
    expect(h.result.current.f.out.has('a')).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    // 收完才离开
    await act(async () => {
      vi.advanceTimersByTime(OUT_MS);
    });
    expect(h.result.current.lg.ids.has('a')).toBe(false);
    expect(h.result.current.f.out.has('a')).toBe(false);
  });

  it('没有一轮在走时：plan 记进 linger，没自动完成的 result 按那个代号拿掉', () => {
    const { h } = setup();
    act(() => h.result.current.f.plan('b', true));
    expect(h.result.current.lg.ids.has('b')).toBe(true);
    act(() => h.result.current.f.result('b', { res: 'failed', auto: null, undo: () => Promise.resolve('ok'), message: '' }));
    expect(h.result.current.lg.ids.has('b')).toBe(false);
  });
});
