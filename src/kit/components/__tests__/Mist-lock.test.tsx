// 输入时的模糊层盖着时，后面的页面拖不动、滚不动（kit/components/Mist.tsx；负责人 11-20“输入框出来以后背景没法动”）：
// 在这一层上的 touchmove、wheel 都被拦下默认；点按照旧交给 onTap
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Mist } from '../Mist.tsx';

describe('Mist 盖着时锁住后面的页面', () => {
  it('touchmove、wheel 拦下默认；点一下照旧回调', () => {
    const onTap = vi.fn();
    render(<Mist onTap={onTap} tag="t" log={() => undefined} testId="m" />);
    const el = screen.getByTestId('m');
    const move = new Event('touchmove', { bubbles: true, cancelable: true });
    el.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    const wheel = new Event('wheel', { bubbles: true, cancelable: true });
    el.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    fireEvent.click(el);
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});
