// 撤销条的第二个按钮（B6 电脑版布局“布局已保存 · 撤销 · 恢复默认布局”，5.9b 第 1 点）：点了做它的事、收起，只回调一次；不给就不画
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UndoToast } from '../UndoToast.tsx';

afterEach(cleanup);

describe('UndoToast 的 more', () => {
  it('点“恢复默认布局”：调 more.onClick、收起；再点撤销不再回调', () => {
    const onUndo = vi.fn();
    const onClose = vi.fn();
    const more = vi.fn();
    render(<UndoToast message="布局已保存" undoLabel="撤销" onUndo={onUndo} onClose={onClose} more={{ label: '恢复默认布局', onClick: more }} data-testid="t" />);
    fireEvent.click(screen.getByTestId('t-more'));
    fireEvent.click(screen.getByTestId('t-undo'));
    expect(more).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('不给 more：只有撤销一个按钮', () => {
    render(<UndoToast message="已删除" undoLabel="撤销" onUndo={() => undefined} onClose={() => undefined} data-testid="t" />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
