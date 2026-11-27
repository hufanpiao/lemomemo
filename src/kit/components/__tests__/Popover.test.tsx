// kit Popover（流畅度实测 11-25 第 2 条改成“用到才挂 Radix”以后，独立评审 11-25 第 5 条补单测）：
// 点按钮能开能关、触发按钮的 aria 属性；收起后焦点回按钮；点外面收起不抢焦点；受控 open 一开始就是 true 时第一次渲染就开着；
// 按钮自己的 ref（对象、回调）都拿得到同一个节点
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Popover } from '../Popover.tsx';

const ui = (extra: Partial<Parameters<typeof Popover>[0]> = {}) => (
  <>
    <input data-testid="outside" aria-label="外面" />
    <Popover label="浮层" data-testid="pop" trigger={<button data-testid="trig">开</button>} {...extra}>
      <button data-testid="inner">里面</button>
    </Popover>
  </>
);

afterEach(() => {
  cleanup();
});

describe('kit Popover', () => {
  it('收着时不挂 Radix、没有浮层；点按钮打开（aria-expanded、aria-controls 对上浮层 id），再点一下收起', async () => {
    render(ui());
    const b = screen.getByTestId('trig');
    expect(screen.queryByTestId('pop')).toBeNull();
    expect(b.getAttribute('type')).toBe('button');
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(b);
    const pop = await screen.findByTestId('pop');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(b.getAttribute('data-state')).toBe('open');
    expect(b.getAttribute('aria-controls')).toBe(pop.id);
    fireEvent.click(b);
    await vi.waitFor(() => expect(screen.queryByTestId('pop')).toBeNull());
    expect(b.getAttribute('aria-expanded')).toBe('false');
    // 触发按钮从头到尾是同一个节点（挂上 Radix 以后也没换）
    expect(screen.getByTestId('trig')).toBe(b);
  });

  it('收起后焦点回到触发按钮（打开时焦点进了浮层）', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByTestId('trig'));
    await screen.findByTestId('pop');
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('inner')));
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByTestId('pop')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('trig'));
  });

  it('点外面收起，不把焦点抢回按钮（焦点留在点到的输入框）', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByTestId('trig'));
    await screen.findByTestId('pop');
    await user.click(screen.getByTestId('outside'));
    await vi.waitFor(() => expect(screen.queryByTestId('pop')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('outside'));
  });

  it('受控 open 一开始就是 true：第一次渲染就开着；点按钮只报 onOpenChange(false)，收不收由外面定', async () => {
    const onOpenChange = vi.fn();
    const v = render(ui({ open: true, onOpenChange }));
    expect(screen.getByTestId('pop')).toBeTruthy();
    expect(screen.getByTestId('trig').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('trig'));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId('pop')).toBeTruthy();
    v.rerender(ui({ open: false, onOpenChange }));
    await vi.waitFor(() => expect(screen.queryByTestId('pop')).toBeNull());
  });

  it('按钮自己的 onClick 先走，preventDefault 了就不开；按钮自己的对象 ref、回调 ref 都拿到同一个节点', async () => {
    const obj = createRef<HTMLButtonElement>();
    const fn = vi.fn();
    const stop = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <>
        <Popover label="甲" data-testid="p1" trigger={<button data-testid="t1" ref={obj} onClick={stop}>甲</button>}>
          <span>甲</span>
        </Popover>
        <Popover label="乙" data-testid="p2" trigger={<button data-testid="t2" ref={fn}>乙</button>}>
          <span>乙</span>
        </Popover>
      </>,
    );
    expect(obj.current).toBe(screen.getByTestId('t1'));
    expect(fn).toHaveBeenCalledWith(screen.getByTestId('t2'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('t1'));
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('p1')).toBeNull();
  });
});
