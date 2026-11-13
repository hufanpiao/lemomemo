// 侧栏给“⋯”留的位置（B6，kit/state/desk-slot.ts）：GlassBar 重新挂上换了元素，用的地方跟着换
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setDeskSlot, useDeskSlot } from '../desk-slot.ts';

function Show() {
  const el = useDeskSlot();
  return <p>{el ? el.id : '无'}</p>;
}

afterEach(() => {
  cleanup();
  setDeskSlot(null);
});

describe('desk-slot', () => {
  it('登记、换一个、卸下：用的地方都跟着变', () => {
    render(<Show />);
    expect(screen.getByText('无')).toBeTruthy();
    const a = document.createElement('span');
    a.id = 'a';
    const b = document.createElement('span');
    b.id = 'b';
    act(() => setDeskSlot(a));
    expect(screen.getByText('a')).toBeTruthy();
    act(() => setDeskSlot(b));
    expect(screen.getByText('b')).toBeTruthy();
    act(() => setDeskSlot(null));
    expect(screen.getByText('无')).toBeTruthy();
  });
});
