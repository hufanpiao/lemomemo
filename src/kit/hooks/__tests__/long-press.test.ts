// 键盘菜单键触发后不吞下一次点按；同一次按住计时器触发过，随后的 contextmenu 不再触发第二次（独立评审 11-19 中 8）
import { describe, expect, it, vi } from 'vitest';
import { HOLD_MS, useLongPress } from '../useLongPress.ts';
import { renderHook } from '@testing-library/react';
import type { MouseEvent, PointerEvent } from 'react';

const ev = <T,>(o: Record<string, unknown> = {}) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...o }) as unknown as T;

describe('useLongPress', () => {
  it('按住到时间触发一次，随后的 contextmenu 不再触发，抬手那一下点按被吃掉', () => {
    vi.useFakeTimers();
    const on = vi.fn();
    const { result } = renderHook(() => useLongPress(on));
    result.current.onPointerDown(ev<PointerEvent>({ isPrimary: true, button: 0, clientX: 0, clientY: 0 }));
    vi.advanceTimersByTime(HOLD_MS);
    expect(on).toHaveBeenCalledTimes(1);
    result.current.onContextMenu(ev<MouseEvent>());
    expect(on).toHaveBeenCalledTimes(1);
    const click = ev<MouseEvent>();
    result.current.onClickCapture(click);
    expect(click.preventDefault).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('键盘菜单键（只有 contextmenu）：触发，但下一次点按照常', () => {
    const on = vi.fn();
    const { result } = renderHook(() => useLongPress(on));
    result.current.onContextMenu(ev<MouseEvent>());
    expect(on).toHaveBeenCalledTimes(1);
    const click = ev<MouseEvent>();
    result.current.onClickCapture(click);
    expect(click.preventDefault).not.toHaveBeenCalled();
  });
});
