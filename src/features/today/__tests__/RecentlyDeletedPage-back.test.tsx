// “最近删除”页的“‹ 返回”（代码审查 M1；R-487 返回栈）：直接打开、没有返回栈的点返回原地换成设置、不退出 App；
// App 里点进来的退回那一页
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../../app/router.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

vi.mock('../hooks/useTrash.ts', () => ({ useTrash: () => ({ items: [], restore: vi.fn() }) }));
const { default: RecentlyDeletedPage } = await import('../ui/RecentlyDeletedPage.tsx');

beforeEach(() => {
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

  it('直接打开（旧版留下的 state，没有返回栈）：原地换成设置，不调用 history.back()', async () => {
    window.history.replaceState({ lemoDepth: 1, lemoDoc: 'old-load' }, '', '/app/#/trash');
    render(<RecentlyDeletedPage />);
    const b = vi.spyOn(window.history, 'back');
    await act(async () => {
      fireEvent.click(screen.getByTestId('trash-back'));
    });
    expect(b).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/settings');
  });

  it('App 里从别的页点进来的：退回那一页（返回栈，R-487），不调用 history.back()', async () => {
    window.history.replaceState(null, '', '/app/#/settings/data');
    await navigate('trash');
    render(<RecentlyDeletedPage />);
    const b = vi.spyOn(window.history, 'back');
    await act(async () => {
      fireEvent.click(screen.getByTestId('trash-back'));
    });
    expect(b).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/settings/data');
  });
});
