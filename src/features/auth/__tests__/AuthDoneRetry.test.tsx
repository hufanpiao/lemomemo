// exe 登录小窗口 auth_done 失败时的提示和“重试”（评审返工第 8 条）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { retryAuthDone } from '../../../platform/desktop-auth.ts';
import { zh } from '../i18n/zh.ts';
import { AuthDoneRetry } from '../ui/AuthDoneRetry.tsx';

afterEach(cleanup);

describe('AuthDoneRetry', () => {
  it('平时不画；auth_done 失败后出提示和“重试”，重试成了提示消失', async () => {
    render(<AuthDoneRetry retry={() => retryAuthDone(async () => null)} />);
    expect(screen.queryByTestId('auth-done-failed')).toBeNull();
    await act(async () => {
      await retryAuthDone(() => Promise.reject(new Error('x')));
    });
    const box = screen.getByTestId('auth-done-failed');
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.textContent).toContain(zh['auth.exe.doneFailed']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.exe.doneRetry'] }));
    });
    expect(screen.queryByTestId('auth-done-failed')).toBeNull();
  });
});
