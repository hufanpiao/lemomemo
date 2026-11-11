// “最近删除”页的“‹ 返回”（代码审查 M1）：iOS 主屏幕版恢复后只剩这一条（state 带上一次载入的编号），点返回原地换成设置、不退出 App；
// App 里点进来的照旧退一步
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate, resetLoadForTest } from '../../../app/router.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

vi.mock('../hooks/useTrash.ts', () => ({ useTrash: () => ({ items: [], restore: vi.fn() }) }));
const { default: RecentlyDeletedPage } = await import('../ui/RecentlyDeletedPage.tsx');

beforeEach(() => {
  resetLoadForTest();
  uiStore.setState({ locale: 'zh-CN' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('最近删除 ‹ 返回', () => {
  it('按钮写“‹ 返回”，读屏名只读“返回”（“‹”是 aria-hidden，同 kit 的 BackLink）', () => {
    window.history.replaceState(null, '', '/app/#/trash');
    render(<RecentlyDeletedPage />);
    const back = screen.getByTestId('trash-back');
    expect(back.textContent).toBe('‹ 返回');
    expect(screen.getByRole('button', { name: '返回' })).toBe(back);
  });

  it('恢复后只剩这一页（深度 1、上一次载入的编号）：原地换成设置，不调用 history.back()', async () => {
    window.history.replaceState({ lemoDepth: 1, lemoDoc: 'old-load' }, '', '/app/#/trash');
    render(<RecentlyDeletedPage />);
    const b = vi.spyOn(window.history, 'back');
    await act(async () => {
      fireEvent.click(screen.getByTestId('trash-back'));
    });
    expect(b).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/settings');
  });

  it('App 里从设置点进来的：照旧退一步', async () => {
    window.history.replaceState(null, '', '/app/#/settings');
    await navigate('trash');
    render(<RecentlyDeletedPage />);
    const b = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    fireEvent.click(screen.getByTestId('trash-back'));
    expect(b).toHaveBeenCalledTimes(1);
  });
});
