// BackLink：页面左上角的“‹ 文字”返回按钮（架构 10.1 唯一出口）
// “‹”和文字之间的空格要看得见：按钮是 inline-flex，两个子节点直接放进去时中间的空格会被丢掉，所以两样包在同一个内层 span 里。
// jsdom 量不出宽度，这里固定结构；真浏览器里的空格宽度由 tests/e2e/back-link-space.spec.ts 量
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackLink } from '../BackLink.tsx';

afterEach(cleanup);

describe('BackLink', () => {
  it('写“‹ 文字”；读屏名只有文字，“‹”带 aria-hidden；带上 testId', () => {
    render(<BackLink label="返回" onBack={() => undefined} testId="x-back" />);
    const btn = screen.getByTestId('x-back');
    expect(btn.textContent).toBe('‹ 返回');
    expect(screen.getByRole('button', { name: '返回' })).toBe(btn);
    expect(btn.querySelector('[aria-hidden="true"]')?.textContent).toBe('‹');
  });

  it('“‹”和文字在同一个内层 span 里（按钮里只有这一个子元素），空格才不会被 inline-flex 丢掉', () => {
    render(<BackLink label="设置" onBack={() => undefined} testId="x-back" />);
    const btn = screen.getByTestId('x-back');
    expect(btn.childNodes).toHaveLength(1);
    expect(btn.firstElementChild?.tagName).toBe('SPAN');
    expect(btn.firstElementChild?.textContent).toBe('‹ 设置');
  });

  it('点一下调 onBack；disabled 时按钮禁用、点了不调', () => {
    const onBack = vi.fn();
    const r = render(<BackLink label="返回" onBack={onBack} testId="x-back" />);
    fireEvent.click(screen.getByTestId('x-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    r.rerender(<BackLink label="返回" onBack={onBack} testId="x-back" disabled />);
    expect((screen.getByTestId('x-back') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('x-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
