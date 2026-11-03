// 表单文本框的草稿提交（代码审查 M1、S6）：失焦 / 回车交；卸载、pagehide、visibilitychange 变 hidden 时补交；同一份只交一次；和外面一样不交
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dateReady, TextArea, TextInput } from '../Form.tsx';

afterEach(() => {
  cleanup();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('草稿补交（M1）', () => {
  it('敲了字没失焦就卸载（后退、跳走）：交一次', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput value="A" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'AB' } });
    expect(onCommit).not.toHaveBeenCalled();
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('AB');
  });

  it('visibilitychange 变成 hidden：交；变回 visible 不再交；之后卸载也不重复交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextArea value="" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: '备注' } });
    setVisibility('visible');
    expect(onCommit).not.toHaveBeenCalled();
    setVisibility('hidden');
    expect(onCommit).toHaveBeenCalledWith('备注');
    setVisibility('visible');
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('pagehide：交', () => {
    const onCommit = vi.fn();
    render(<TextInput value="" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'x' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(onCommit).toHaveBeenCalledWith('x');
  });

  it('改回和外面一样、或者根本没改：不交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput value="A" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'AB' } });
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'A' } });
    fireEvent.blur(screen.getByTestId('t'));
    window.dispatchEvent(new Event('pagehide'));
    unmount();
    expect(onCommit).not.toHaveBeenCalled();
    const other = vi.fn();
    const r2 = render(<TextInput value="B" onCommit={other} data-testid="t2" />);
    r2.unmount();
    expect(other).not.toHaveBeenCalled();
  });

  it('失焦交过一次：卸载不重复交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput value="A" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'AB' } });
    fireEvent.blur(screen.getByTestId('t'));
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
  });
});

describe('日期框（S6）', () => {
  it('dateReady：空串、年份 ≥ 1900 的合法格式才算定了', () => {
    expect(dateReady('')).toBe(true);
    expect(dateReady('2026-11-05')).toBe(true);
    expect(dateReady('1900-01-01')).toBe(true);
    for (const v of ['0002-11-05', '0020-11-05', '0202-11-05', '1899-12-31', '2026-1-5', 'x']) expect(dateReady(v)).toBe(false);
  });

  it('逐位敲年份：中间那几个不交，敲够了才交；卸载时没敲够的也不交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput type="date" value="2026-11-05" onCommit={onCommit} data-testid="d" />);
    const el = screen.getByTestId('d');
    fireEvent.focus(el);
    for (const v of ['0002-11-05', '0020-11-05', '0202-11-05']) fireEvent.change(el, { target: { value: v } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(el, { target: { value: '2027-11-05' } });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('2027-11-05');
    fireEvent.change(el, { target: { value: '0003-11-05' } });
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('时刻框：选完就交', () => {
    const onCommit = vi.fn();
    render(<TextInput type="time" value="09:00" onCommit={onCommit} data-testid="tm" />);
    fireEvent.focus(screen.getByTestId('tm'));
    fireEvent.change(screen.getByTestId('tm'), { target: { value: '10:30' } });
    expect(onCommit).toHaveBeenCalledWith('10:30');
  });
});
