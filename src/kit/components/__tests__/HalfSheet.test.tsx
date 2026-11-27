// 半屏抽屉（kit HalfSheet，R-492 方向 B）：松手去哪（sheetTarget）、挂上是半屏、强制拉满（往下拖只弹回）、点后面的模糊层、Esc、调用方的关闭按钮都走带退场的 close、
// 减少动态效果不等收尾、读屏名字和模态
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HalfSheet, SHEET_DRAG_PX, SHEET_MS, sheetTarget } from '../HalfSheet.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('sheetTarget', () => {
  it('半屏：往下拖过阈值或甩得快 → 关；往上 → 拉满；没过阈值 → 留在半屏', () => {
    expect(sheetTarget('half', SHEET_DRAG_PX + 1, 0)).toBe('close');
    expect(sheetTarget('half', 10, 0.8)).toBe('close');
    expect(sheetTarget('half', -SHEET_DRAG_PX - 1, 0)).toBe('full');
    expect(sheetTarget('half', 20, 0.1)).toBe('half');
  });
  it('拉满：往下拖过阈值 → 半屏（不直接关）；往上、没过阈值 → 留在拉满', () => {
    expect(sheetTarget('full', SHEET_DRAG_PX + 1, 0)).toBe('half');
    expect(sheetTarget('full', -200, -2)).toBe('full');
    expect(sheetTarget('full', 30, 0)).toBe('full');
  });
});

describe('HalfSheet', () => {
  const mount = (p: { full?: boolean; onClose?: () => void; onStop?: (s: string) => void } = {}) =>
    render(
      <HalfSheet label="AI 助手" onClose={p.onClose ?? (() => undefined)} full={p.full ?? false} onStop={p.onStop} log={() => undefined} tag="t">
        <p>内容</p>
      </HalfSheet>,
    );

  it('挂上是半屏、模态对话框、带读屏名字；停靠点报给调用方', () => {
    const onStop = vi.fn();
    mount({ onStop });
    const sheet = screen.getByTestId('t-sheet');
    expect(sheet.getAttribute('data-stop')).toBe('half');
    expect(screen.getByRole('dialog', { name: 'AI 助手' }).getAttribute('aria-modal')).toBe('true');
    expect(onStop).toHaveBeenLastCalledWith('half');
  });

  it('强制拉满（键盘弹着）', () => {
    mount({ full: true });
    expect(screen.getByTestId('t-sheet').getAttribute('data-stop')).toBe('full');
  });

  it('点后面的模糊层：先滑下去，收尾时长到了才关', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.click(screen.getByTestId('t-mist'));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SHEET_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc 也走带退场的 close：先滑下去，收尾时长到了才关', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('t-sheet').style.transform).toBe('translateY(100%)');
    act(() => vi.advanceTimersByTime(SHEET_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('children 写成函数拿到 close：调用方的“关闭”按钮同样带退场；时长是 motion 的 dur.sheet', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <HalfSheet label="AI 助手" onClose={onClose} log={() => undefined} tag="t">
        {(close) => <button type="button" onClick={close}>关闭</button>}
      </HalfSheet>,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SHEET_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(SHEET_MS).toBe(380);
  });

  it('减少动态效果（data-rm="1"）：关的时候不等收尾时长', () => {
    vi.useFakeTimers();
    document.documentElement.dataset['rm'] = '1';
    try {
      const onClose = vi.fn();
      mount({ onClose });
      fireEvent.click(screen.getByTestId('t-mist'));
      act(() => vi.advanceTimersByTime(0));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      delete document.documentElement.dataset['rm'];
    }
  });

  it('强制拉满时往下拖过阈值：只弹回原处，不换停靠点、不关', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onStop = vi.fn();
    mount({ full: true, onClose, onStop });
    const grab = screen.getByTestId('t-grab');
    fireEvent.pointerDown(grab, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(grab, { pointerId: 1, clientY: 100 + SHEET_DRAG_PX * 3 });
    fireEvent.pointerUp(grab, { pointerId: 1, clientY: 100 + SHEET_DRAG_PX * 3 });
    act(() => vi.advanceTimersByTime(SHEET_MS * 2));
    const sheet = screen.getByTestId('t-sheet');
    expect(sheet.getAttribute('data-stop')).toBe('full');
    expect(sheet.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalledWith('half');
  });
});
