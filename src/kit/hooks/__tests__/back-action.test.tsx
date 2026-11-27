// 眼前这一页的返回（kit/hooks/back-action.ts，负责人 11-22“左滑是返回上一页”）：最后登记的算数，撤掉以后退回前一个；BackLink 挂上登记、卸下撤掉
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackLink } from '../../components/BackLink.tsx';
import { currentBack, registerBack } from '../back-action.ts';

afterEach(cleanup);

describe('back-action', () => {
  it('最后登记的是眼前这一页；撤掉以后退回前一个，全撤了是 null', () => {
    const a = { run: vi.fn(), off: () => false };
    const b = { run: vi.fn(), off: () => false };
    const ua = registerBack(a);
    const ub = registerBack(b);
    expect(currentBack()).toBe(b);
    ub();
    expect(currentBack()).toBe(a);
    ub();
    expect(currentBack()).toBe(a);
    ua();
    expect(currentBack()).toBeNull();
  });
  it('BackLink 挂上登记它的 onBack（换了 onBack、disabled 用新的），卸下撤掉', () => {
    const one = vi.fn();
    const two = vi.fn();
    const v = render(<BackLink label="返回" onBack={one} testId="b" />);
    currentBack()?.run();
    expect(one).toHaveBeenCalledTimes(1);
    v.rerender(<BackLink label="返回" onBack={two} testId="b" disabled />);
    currentBack()?.run();
    expect(two).toHaveBeenCalledTimes(1);
    expect(currentBack()?.off()).toBe(true);
    v.unmount();
    expect(currentBack()).toBeNull();
  });
});
