// Wheel：滚轮（kit）。jsdom 不会真的滚动和吸附：这里只测读屏、键盘、点选和“停稳后读出第几项”；
// 真浏览器里的滚动吸附由 tests/e2e/b5-anniv.spec.ts 在 chromium、webkit 上跑
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wheel } from '../Wheel.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const OPTS = ['1', '2', '3', '4', '5', '6', '7', '8'].map((v) => ({ value: v, label: `${v}月` }));

describe('Wheel', () => {
  it('整列是 spinbutton：读出当前项；选项对读屏隐藏', () => {
    render(<Wheel label="月份" options={OPTS} value="3" onChange={() => undefined} data-testid="w" />);
    const w = screen.getByRole('spinbutton', { name: '月份' });
    expect(w.getAttribute('aria-valuetext')).toBe('3月');
    expect(w.querySelector('[data-value="3"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(w.querySelector('[data-value="3"]')?.hasAttribute('data-on')).toBe(true);
  });

  it('键盘：↓ 下一项、↑ 上一项、Home、End、PageDown；到头不越界', () => {
    const onChange = vi.fn();
    render(<Wheel label="月份" options={OPTS} value="1" onChange={onChange} data-testid="w" />);
    const w = screen.getByTestId('w');
    fireEvent.keyDown(w, { key: 'ArrowDown' });
    fireEvent.keyDown(w, { key: 'ArrowUp' });
    fireEvent.keyDown(w, { key: 'End' });
    fireEvent.keyDown(w, { key: 'PageDown' });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['2', '8', '6']);
  });

  it('点某一项直接选它；disabled 时不响应、不进 Tab 顺序', () => {
    const onChange = vi.fn();
    const r = render(<Wheel label="月份" options={OPTS} value="1" onChange={onChange} data-testid="w" />);
    fireEvent.click(screen.getByTestId('w').querySelector('[data-value="4"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('4');
    r.rerender(<Wheel label="月份" options={OPTS} value="1" onChange={onChange} disabled data-testid="w" />);
    fireEvent.click(screen.getByTestId('w').querySelector('[data-value="5"]') as HTMLElement);
    fireEvent.keyDown(screen.getByTestId('w'), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('w').tabIndex).toBe(-1);
  });

  it('滚动停稳 120ms 后按位置读出第几项（每项 38 高），只在变了时回调', () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(38);
    const onChange = vi.fn();
    render(<Wheel label="月份" options={OPTS} value="1" onChange={onChange} data-testid="w" />);
    const w = screen.getByTestId('w');
    w.scrollTop = 38 * 4 + 10;
    fireEvent.scroll(w);
    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledWith('5');
  });
});
