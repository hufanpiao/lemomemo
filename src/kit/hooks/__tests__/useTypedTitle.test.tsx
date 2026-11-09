// 打字条“展开编辑”把字带进新建页（kit/state/new-item.ts + kit/hooks/useTypedTitle.ts；B3 R-353 不丢字）：
// • 日子、字都是取一次就清；看一眼（newItemDay）不清
// • 新建页（id 'new'）挂上时取走字、填进标题；StrictMode 下也只填一次；空白字不填；编辑已有条目（id 不是 'new'）不取
import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newItemDay, setNewItemDay, setNewItemTitle, takeNewItemDay, takeNewItemTitle } from '../../state/new-item.ts';
import { useTypedTitle } from '../useTypedTitle.ts';

afterEach(() => {
  cleanup();
  setNewItemDay(null);
  setNewItemTitle(null);
});

function Form({ id, change }: { id: string; change: (p: { title: string }) => void }) {
  useTypedTitle(id, change);
  return null;
}

describe('new-item', () => {
  it('日子：看一眼不清，取走就清', () => {
    setNewItemDay('2026-11-09');
    expect(newItemDay()).toBe('2026-11-09');
    expect(takeNewItemDay()).toBe('2026-11-09');
    expect(takeNewItemDay()).toBeNull();
  });

  it('字：取走就清', () => {
    setNewItemTitle('买牛奶');
    expect(takeNewItemTitle()).toBe('买牛奶');
    expect(takeNewItemTitle()).toBeNull();
  });
});

describe('useTypedTitle', () => {
  it('新建页挂上：取走字填进标题，StrictMode 下也只填一次，取走以后下次新建不沿用', () => {
    setNewItemTitle('明天下午三点开会');
    const change = vi.fn();
    render(
      <StrictMode>
        <Form id="new" change={change} />
      </StrictMode>,
    );
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith({ title: '明天下午三点开会' });
    expect(takeNewItemTitle()).toBeNull();
  });

  it('空白字不填；没带字不填', () => {
    setNewItemTitle('   ');
    const change = vi.fn();
    render(<Form id="new" change={change} />);
    cleanup();
    render(<Form id="new" change={change} />);
    expect(change).not.toHaveBeenCalled();
  });

  it('编辑已有条目不取字（留给下一次新建）', () => {
    setNewItemTitle('买牛奶');
    const change = vi.fn();
    render(<Form id="abc" change={change} />);
    expect(change).not.toHaveBeenCalled();
    expect(takeNewItemTitle()).toBe('买牛奶');
  });
});
