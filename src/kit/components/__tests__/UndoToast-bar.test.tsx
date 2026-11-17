// 撤销条底边的倒计时色带（R-450，负责人 11-17“所有完成或者删除后等待的提示框要有一个倒计时的色带”）：
// 所有撤销条都是 kit 的 UndoToast，色带画在这里一处；时长和自动收起的 ms 是同一个数；
// 悬停、焦点在条上时计时停了，色带不画；移开后换一轮（key 变了，动画从满格重来），和“移开后重新计 ms”对得上
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UNDO_TOAST_MS, UndoToast } from '../UndoToast.tsx';

afterEach(cleanup);

const noop = (): void => undefined;

describe('UndoToast 的倒计时色带', () => {
  it('默认画一条，时长等于自动收起的 8 秒；读屏不读', () => {
    render(<UndoToast message="已删除" undoLabel="撤销" onUndo={noop} onClose={noop} data-testid="t" />);
    const bar = screen.getByTestId('t-bar');
    expect(bar.style.animationDuration).toBe(`${UNDO_TOAST_MS}ms`);
    expect(bar.getAttribute('aria-hidden')).toBe('true');
  });

  it('自定 ms：色带时长跟着变', () => {
    render(<UndoToast message="已记下" onClose={noop} ms={3000} data-testid="t" />);
    expect(screen.getByTestId('t-bar').style.animationDuration).toBe('3000ms');
  });

  it('悬停时不画；移开后重新出现，是新的一条（从满格重新走）', () => {
    render(<UndoToast message="已删除" undoLabel="撤销" onUndo={noop} onClose={noop} data-testid="t" />);
    const first = screen.getByTestId('t-bar');
    fireEvent.mouseEnter(screen.getByTestId('t'));
    expect(screen.queryByTestId('t-bar')).toBeNull();
    fireEvent.mouseLeave(screen.getByTestId('t'));
    const again = screen.getByTestId('t-bar');
    expect(again).not.toBe(first);
  });
});
