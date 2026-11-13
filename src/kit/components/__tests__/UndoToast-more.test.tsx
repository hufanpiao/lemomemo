// 撤销条的第二个按钮（B6 电脑版布局“布局已保存 · 撤销 · 恢复默认布局”，5.9b 第 1 点）：点了做它的事、收起，只回调一次；不给就不画
// solo（B6 返工“两个撤销条不能叠在一起”）：带 solo 的条新出来一条，旧的收起（onClose 一次、不撤销）；不带 solo 的不受影响
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

describe('UndoToast 的 solo', () => {
  it('新的 solo 条出来：旧的 solo 条收起（onClose 一次、不撤销），不带 solo 的不动', () => {
    const old = { undo: vi.fn(), close: vi.fn() };
    const other = vi.fn();
    const { rerender } = render(
      <>
        <UndoToast message="已删除" undoLabel="撤销" onUndo={old.undo} onClose={old.close} solo data-testid="a" />
        <UndoToast message="冲突" undoLabel="撤销" onUndo={() => undefined} onClose={other} data-testid="c" />
      </>,
    );
    expect(old.close).not.toHaveBeenCalled();
    rerender(
      <>
        <UndoToast message="已删除" undoLabel="撤销" onUndo={old.undo} onClose={old.close} solo data-testid="a" />
        <UndoToast message="冲突" undoLabel="撤销" onUndo={() => undefined} onClose={other} data-testid="c" />
        <UndoToast message="布局已保存" undoLabel="撤销" onUndo={() => undefined} onClose={() => undefined} solo data-testid="b" />
      </>,
    );
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(old.undo).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    // 被顶掉以后再点它的撤销：不再回调
    fireEvent.click(screen.getByTestId('a-undo'));
    expect(old.undo).not.toHaveBeenCalled();
  });
});
