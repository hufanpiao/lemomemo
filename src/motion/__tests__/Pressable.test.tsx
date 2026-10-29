// 按下回弹的状态标记（架构 17.1、17.2 第 2 点；TC-B1-51 的按下回弹）：按下是 pressed，松开、移出、被取消（触屏开始滚动）都回到 idle
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pressable } from '../Pressable.tsx';

function setup() {
  const onPointerCancel = vi.fn();
  render(<Pressable onPointerCancel={onPointerCancel}>ok</Pressable>);
  return { btn: screen.getByRole('button'), onPointerCancel };
}

describe('Pressable 的 data-state', () => {
  afterEach(cleanup);

  it('按下 → pressed，抬起 → idle', () => {
    const { btn } = setup();
    expect(btn.dataset['state']).toBe('idle');
    fireEvent.pointerDown(btn);
    expect(btn.dataset['state']).toBe('pressed');
    fireEvent.pointerUp(btn);
    expect(btn.dataset['state']).toBe('idle');
  });

  it('按下后开始滚动（pointercancel，没有 pointerup）→ 回到 idle，调用方的 onPointerCancel 照样收到', () => {
    const { btn, onPointerCancel } = setup();
    fireEvent.pointerDown(btn);
    fireEvent.pointerCancel(btn);
    expect(btn.dataset['state']).toBe('idle');
    expect(onPointerCancel).toHaveBeenCalledOnce();
  });

  it('按下后移出 → idle', () => {
    const { btn } = setup();
    fireEvent.pointerDown(btn);
    fireEvent.pointerLeave(btn);
    expect(btn.dataset['state']).toBe('idle');
  });
});
