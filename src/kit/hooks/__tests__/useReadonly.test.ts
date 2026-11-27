// kit 的只读行钩子（FA-2）：repeatPendingOf 只数只读、还在用、repeat 不为空的行；
// useReadonlyGuard 的页面提示条到点收起（负责人 11-20：出错条统一 TOAST_MS 5 秒收起，撤销条 show(x, null) 由 UndoToast 自己计时）
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MS } from '../../../../shared/logic/toast.ts';
import { useReadonlyGuard } from '../useReadonly.ts';
import { repeatPendingOf } from '../useRepeatPending.ts';

describe('repeatPendingOf', () => {
  it('只读 + repeat 不为空 + 没删没撤销才算', () => {
    const rows = [
      { id: 'a', repeat: { freq: 'week' }, deleted_at: null },
      { id: 'b', repeat: { freq: 'week' }, deleted_at: null },   // 不是只读（新版改成可写了）
      { id: 'c', repeat: null, deleted_at: null },                // 只读，但原因是别的不认识的值
      { id: 'd', repeat: { freq: 'day' }, deleted_at: 5 },        // 删了
      { id: 'e', repeat: { freq: 'day' }, undone: true },         // 撤销了
      { id: 'f', repeat: 'FREQ=DAILY' },                          // 新版本的格式不认识也算
    ];
    expect(repeatPendingOf(rows, new Set(['a', 'c', 'd', 'e', 'f']))).toBe(2);
    expect(repeatPendingOf(rows, new Set())).toBe(0);
  });
});

describe('useReadonlyGuard 页面提示条收起', () => {
  afterEach(() => vi.useRealTimers());
  type T = { kind: string };

  it('show 默认 TOAST_MS 收起：差 0.1 秒还在，过 0.1 秒收起', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReadonlyGuard<T>());
    act(() => result.current.show({ kind: 'error' }));
    act(() => vi.advanceTimersByTime(TOAST_MS - 100));
    expect(result.current.toast).toEqual({ kind: 'error' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.toast).toBeNull();
  });

  it('show(x, null)（撤销条）不收；连出两次同一条重新计时；被下一条顶掉后不误收下一条', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReadonlyGuard<T>());
    const undo = { kind: 'undo' };
    act(() => result.current.show(undo, null));
    act(() => vi.advanceTimersByTime(TOAST_MS * 3));
    expect(result.current.toast).toBe(undo);
    const err = { kind: 'error' };
    act(() => result.current.show(err));
    act(() => vi.advanceTimersByTime(TOAST_MS - 1000));
    act(() => result.current.show(err));
    act(() => vi.advanceTimersByTime(TOAST_MS - 100));
    expect(result.current.toast).toBe(err);
    // 出错条计时中换成撤销条：到点不收撤销条
    act(() => result.current.show(undo, null));
    act(() => vi.advanceTimersByTime(TOAST_MS));
    expect(result.current.toast).toBe(undo);
  });
});
