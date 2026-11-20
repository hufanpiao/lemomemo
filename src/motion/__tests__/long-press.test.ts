// 键盘菜单键触发后不吞下一次点按；同一次按住计时器触发过，随后的 contextmenu 不再触发第二次（独立评审 11-19 中 8）
// 触发以后在按钮上抬手：随后补来的那一下 click 吞掉（swallowNextClick，只吞落在按钮里的一下）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MouseEvent, PointerEvent } from 'react';
import { useLongPress } from '../long-press.ts';
import { LIFT_MS } from '../long-press-drag.ts';

const ev = <T,>(o: Record<string, unknown> = {}) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...o }) as unknown as T;
const click = (el: Element): boolean => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('useLongPress', () => {
  it('按住到时间触发一次，随后的 contextmenu 不再触发，抬手那一下点按被吃掉（只吃按钮里的一下）', () => {
    vi.useFakeTimers();
    const btn = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(btn, other);
    const on = vi.fn();
    const { result } = renderHook(() => useLongPress(on));
    result.current.onPointerDown(ev<PointerEvent>({ isPrimary: true, button: 0, clientX: 0, clientY: 0 }));
    vi.advanceTimersByTime(LIFT_MS);
    expect(on).toHaveBeenCalledTimes(1);
    result.current.onContextMenu(ev<MouseEvent>());
    expect(on).toHaveBeenCalledTimes(1);
    result.current.onPointerUp(ev<PointerEvent>({ currentTarget: btn }));
    expect(click(other)).toBe(true);
    expect(click(btn)).toBe(false);
    expect(click(btn)).toBe(true);
  });

  it('没按够时间就抬手：那一下点按照常', () => {
    vi.useFakeTimers();
    const btn = document.createElement('button');
    document.body.append(btn);
    const on = vi.fn();
    const { result } = renderHook(() => useLongPress(on));
    result.current.onPointerDown(ev<PointerEvent>({ isPrimary: true, button: 0, clientX: 0, clientY: 0 }));
    vi.advanceTimersByTime(LIFT_MS - 1);
    result.current.onPointerUp(ev<PointerEvent>({ currentTarget: btn }));
    expect(on).not.toHaveBeenCalled();
    expect(click(btn)).toBe(true);
  });

  it('键盘菜单键（只有 contextmenu）：触发，但下一次点按照常', () => {
    const btn = document.createElement('button');
    document.body.append(btn);
    const on = vi.fn();
    const { result } = renderHook(() => useLongPress(on));
    result.current.onContextMenu(ev<MouseEvent>());
    expect(on).toHaveBeenCalledTimes(1);
    expect(click(btn)).toBe(true);
  });
});
