// 登录页的退出原因（K6 复审 A）：主 App 被移除、被停用、注销冷静期清本机后跳过来，先说一句为什么；显示一次就删
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitNoticeOf, readExitNotice, setExitNotice } from '../../../platform/session.ts';
import { zh } from '../i18n/zh.ts';
import { fakeApi, renderPage, resetHarness } from './auth-page-harness.tsx';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(() => {
  resetHarness();
  sessionStorage.clear();
});
afterEach(cleanup);

describe('登录页：退出原因', () => {
  it('deletion_unsure（申请注销后确认不了，安全审查 H1）：显示 auth.exit.deletionUnsure，不出现冷静期文字', async () => {
    setExitNotice('deletion_unsure');
    await renderPage(fakeApi());
    const line = screen.getByTestId('auth-exit-notice');
    expect(line.getAttribute('data-reason')).toBe('deletion_unsure');
    expect(line.textContent).toBe(zh['auth.exit.deletionUnsure']);
    expect(line.textContent).not.toContain('冷静期');
  });

  it.each([
    ['account_disabled', 'disabled', 'auth.exit.disabled'],
    ['account_pending_deletion', 'pending_deletion', 'auth.exit.pendingDeletion'],
    ['session_revoked', 'removed', 'auth.exit.removed'],
  ] as const)('%s → %s：role=alert 显示对应文案，显示后删掉（刷新不再出现）', async (code, notice, key) => {
    expect(exitNoticeOf(code)).toBe(notice);
    setExitNotice(exitNoticeOf(code));
    await renderPage(fakeApi());
    const line = screen.getByTestId('auth-exit-notice');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.getAttribute('data-reason')).toBe(notice);
    expect(line.textContent).toBe(zh[key]);
    expect(readExitNotice()).toBeNull();
  });

  it('disabled_unsure（主 App 收到 account_disabled、探测不出是停用还是冷静期）：显示不确定的说法，两种情况都说到', async () => {
    setExitNotice('disabled_unsure');
    await renderPage(fakeApi());
    const line = screen.getByTestId('auth-exit-notice');
    expect(line.getAttribute('data-reason')).toBe('disabled_unsure');
    expect(line.textContent).toBe(zh['auth.exit.disabledUnsure']);
    expect(readExitNotice()).toBeNull();
  });

  it('没有退出原因、或值不认识：不显示', async () => {
    sessionStorage.setItem('lemo.exit_notice', 'whatever');
    await renderPage(fakeApi());
    expect(screen.queryByTestId('auth-exit-notice')).toBeNull();
  });
});
