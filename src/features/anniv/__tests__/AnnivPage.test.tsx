// 纪念日占位页（B2 全站视觉审查 A2、FA-2 审查第 7 条）：地址栏手打 #/anniv 进来的，原地换回日历页（替换这条历史，后退不会回到占位页）
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const { default: AnnivPage } = await import('../ui/AnnivPage.tsx');

afterEach(() => {
  cleanup();
});

describe('纪念日占位页', () => {
  it('打开就换回日历页，不多一条历史；页面什么也不画', async () => {
    window.history.replaceState(null, '', '/app/#/anniv');
    const before = window.history.length;
    const { container } = render(<AnnivPage />);
    expect(container.textContent).toBe('');
    await waitFor(() => expect(window.location.hash).toBe('#/calendar'));
    expect(window.history.length).toBe(before);
  });
});
