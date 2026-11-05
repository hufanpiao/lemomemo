// exe 里删会话失败时的整屏提示（app/ExitIncompleteScreen.tsx；安全审查 A-1、代码审查 A-M1、建议 4）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../shared/i18n/zh.ts';
import { uiStore } from '../../kit/state/ui-store.ts';

const reloadPage = vi.fn();
vi.mock('../../platform/sw-register.ts', () => ({ reloadPage: () => reloadPage() }));

const { ExitIncompleteScreen } = await import('../ExitIncompleteScreen.tsx');
const { mountExitScreen, watchExitIncomplete } = await import('../exit-screen.tsx');
const { clearDropMark, resetSessionBackendForTest, showExitIncomplete } = await import('../../platform/session-store.ts');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  reloadPage.mockClear();
  resetSessionBackendForTest();
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-exit-screen-host]').forEach((n) => n.remove());
});

describe('退出没完成（A-1）', () => {
  it('重试：忙的时候写“正在删除…”；还是失败写一句提示，按钮还能再点', async () => {
    let finish!: (ok: boolean) => void;
    const retry = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    render(<ExitIncompleteScreen kind="incomplete" retry={retry} />);
    expect(screen.getByRole('alertdialog').textContent).toContain(zh['exit.incomplete.title']);
    fireEvent.click(screen.getByTestId('exit-screen-action'));
    expect(screen.getByTestId('exit-screen-action').textContent).toBe(zh['exit.incomplete.busy']);
    fireEvent.click(screen.getByTestId('exit-screen-action'));
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => finish(false));
    expect(screen.getByRole('status').textContent).toBe(zh['exit.incomplete.failed']);
    expect(screen.getByTestId('exit-screen-action').textContent).toBe(zh['exit.incomplete.retry']);
  });

  it('读不到登录信息（建议 4）：只给“重新打开”，点了重新载入', () => {
    const reload = vi.fn();
    render(<ExitIncompleteScreen kind="unavailable" reload={reload} />);
    expect(screen.getByRole('alertdialog').textContent).toContain(zh['exit.unavailable.title']);
    fireEvent.click(screen.getByTestId('exit-screen-action'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('挂出时 #root 加 inert、焦点在按钮上；卸掉时还原 inert（安全复审建议 ②）', async () => {
    const app = document.createElement('div');
    app.id = 'root';
    app.innerText = '账号界面';
    document.body.appendChild(app);
    let unmount!: () => void;
    act(() => {
      unmount = mountExitScreen('incomplete');
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('exit-screen-action')));
    expect(app.hasAttribute('inert')).toBe(true);
    act(() => unmount());
    expect(app.hasAttribute('inert')).toBe(false);
    app.remove();
  });

  it('watchExitIncomplete：goToAuth 判失败时挂出整屏；之后删除状态回到 ok（晚到的成功）就重新载入', async () => {
    const stop = watchExitIncomplete(document, reloadPage);
    expect(document.querySelector('[data-exit-screen-host]')).toBeNull();
    localStorage.setItem('lemo.session-drop-pending', '1');
    act(() => showExitIncomplete());
    await waitFor(() => expect(screen.getByTestId('exit-screen').getAttribute('data-kind')).toBe('incomplete'));
    expect(reloadPage).not.toHaveBeenCalled();
    act(() => clearDropMark());
    expect(reloadPage).toHaveBeenCalledOnce();
    stop();
  });
});

describe('整屏提示按需下载（11-05 首屏瘦身）', () => {
  it('挂出时先加 inert，不等下载；下载失败画静态兜底“刷新一下”，点了重新载入', async () => {
    const app = document.createElement('div');
    app.id = 'root';
    document.body.appendChild(app);
    let unmount!: () => void;
    act(() => {
      unmount = mountExitScreen('unavailable', document, () => Promise.reject(new Error('chunk')));
    });
    expect(app.hasAttribute('inert')).toBe(true);
    const fb = await screen.findByTestId('app-crash-fallback');
    expect(fb.textContent).toContain(zh['app.crashed.refresh']);
    fireEvent.click(screen.getByRole('button'));
    expect(reloadPage).toHaveBeenCalledOnce();
    act(() => unmount());
    expect(app.hasAttribute('inert')).toBe(false);
    app.remove();
  });

  it('下载期间就卸掉：下载好也不再画，宿主不留', async () => {
    let done!: (m: { ExitIncompleteScreen: typeof ExitIncompleteScreen }) => void;
    const unmount = mountExitScreen('incomplete', document, () => new Promise((r) => (done = r)));
    unmount();
    await act(async () => done({ ExitIncompleteScreen }));
    expect(document.querySelector('[data-exit-screen-host]')).toBeNull();
    expect(screen.queryByTestId('exit-screen')).toBeNull();
  });
});
