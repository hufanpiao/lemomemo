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

  it('禁用时按下不进 pressed（B2-UI-a U3-5）：aria-disabled（只读行的 ×）、disabled 都停在 idle，减少动态效果那一支也就不变淡', () => {
    render(
      <>
        <Pressable aria-disabled="true">a</Pressable>
        <Pressable aria-disabled>b</Pressable>
        <Pressable disabled>c</Pressable>
        <Pressable aria-disabled="false">d</Pressable>
      </>,
    );
    const [a, b, c, d] = screen.getAllByRole('button');
    for (const btn of [a, b, c]) {
      fireEvent.pointerDown(btn as HTMLElement);
      expect((btn as HTMLElement).dataset['state']).toBe('idle');
    }
    fireEvent.pointerDown(d as HTMLElement);
    expect((d as HTMLElement).dataset['state']).toBe('pressed');
  });

  it('按下后移出 → idle', () => {
    const { btn } = setup();
    fireEvent.pointerDown(btn);
    fireEvent.pointerLeave(btn);
    expect(btn.dataset['state']).toBe('idle');
  });
});

// UI-4 B1 动效确认 C3（X-3）：按下和松开分开写；切页前的瞬间复位挂在 data-snap 上
describe('Pressable 按下不过冲、切页前能瞬间复位（C3）', () => {
  afterEach(cleanup);

  it('按钮上带 data-pressable（motion 的 transition() 靠它找到所有 Pressable）', () => {
    render(<Pressable>ok</Pressable>);
    expect(screen.getByRole('button').hasAttribute('data-pressable')).toBe(true);
  });

  it('CSS：按下用 --ease-out（不过冲），松开回 idle 用 --ease-spring；data-snap 写在 pressed 之后、去掉过渡回到原大小', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(import.meta.dirname, '..', 'Pressable.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const top = css.slice(0, css.indexOf('@media'));
    const block = (sel: string) => {
      const at = top.indexOf(`\n${sel} {`);
      if (at < 0) return '';
      const open = top.indexOf('{', at);
      return top.slice(open + 1, top.indexOf('}', open)).replace(/\s+/g, ' ').trim();
    };
    expect(block('.pressable')).toBe('transition: transform var(--dur-press) var(--ease-spring);');
    expect(block('.pressable[data-state="pressed"]')).toBe('transform: scale(0.97); transition: transform var(--dur-press) var(--ease-out);');
    expect(block('.pressable[data-snap]')).toBe('transform: none; transition: none;');
    expect(top.indexOf('.pressable[data-snap]')).toBeGreaterThan(top.indexOf('.pressable[data-state="pressed"]'));
  });
});
