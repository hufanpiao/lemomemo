// 今天页、随手记页共用的详情抽屉选中状态（kit useListActions.ts 的 useDrawerSel，B6 整合）：电脑版换上才开抽屉、不然进编辑页；
// 电脑版画出错（fail）以后按没换上算并清空；删掉开着的那一条时一起关
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDrawerSel } from '../useListActions.ts';

describe('useDrawerSel', () => {
  it('电脑版没换上：open 调 go，不开抽屉', () => {
    const go = vi.fn();
    const { result } = renderHook(() => useDrawerSel<{ id: string }>(false));
    act(() => result.current.open({ id: 'a' }, go));
    expect(go).toHaveBeenCalledTimes(1);
    expect(result.current.sel).toBeNull();
  });

  it('换上了：open 开抽屉；forget 别的不动，forget 自己就关', () => {
    const go = vi.fn();
    const { result } = renderHook(() => useDrawerSel<{ id: string }>(true));
    act(() => result.current.open({ id: 'a' }, go));
    expect(result.current.sel).toEqual({ id: 'a' });
    act(() => result.current.forget('b'));
    expect(result.current.sel).toEqual({ id: 'a' });
    act(() => result.current.forget('a'));
    expect(result.current.sel).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  it('电脑版画出错（fail）或卸下：清空，以后点开进编辑页', () => {
    const go = vi.fn();
    const { result, rerender } = renderHook(({ on }) => useDrawerSel<{ id: string }>(on), { initialProps: { on: true } });
    act(() => result.current.open({ id: 'a' }, go));
    act(() => result.current.fail());
    expect(result.current.on).toBe(false);
    expect(result.current.sel).toBeNull();
    act(() => result.current.open({ id: 'a' }, go));
    expect(go).toHaveBeenCalledTimes(1);
    // 窗口变窄（loaded 变 false）也清空
    const r2 = renderHook(({ on }) => useDrawerSel<{ id: string }>(on), { initialProps: { on: true } });
    act(() => r2.result.current.open({ id: 'b' }, go));
    r2.rerender({ on: false });
    expect(r2.result.current.sel).toBeNull();
    rerender({ on: true });
    expect(result.current.on).toBe(false);
  });
});
