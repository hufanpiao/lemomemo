// 登录页的“登录已过期”（R-382 架构 4.1a 第 2 点、第 6 点单测）：有 lemo.reauth 时说内容还在、只数一次 outbox、联网查一次 session_fate、
// 换账号提示 N 条没同步、“清除这台设备上的内容”先确认再清；已停用（负责人 11-11 定：只退出不清本机）显示“已停用”、不查 session_fate
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setExitNotice, readExitNotice } from '../../../platform/session.ts';
import type { ReauthDeps } from '../data/reauth.ts';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { fakeAccount, fakeApi, resetHarness } from './auth-page-harness.tsx';
import { turnstile } from './turnstile-fake.ts';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';

function deps(o: Partial<ReauthDeps> = {}): ReauthDeps & Record<keyof ReauthDeps, ReturnType<typeof vi.fn>> {
  return {
    read: vi.fn(() => ({ v: 1 as const, user_id: A, session_id: S, at: 1 })),
    count: vi.fn(async () => 0),
    online: vi.fn(() => true),
    onOnline: vi.fn(() => () => undefined),
    fate: vi.fn(async () => 'unknown' as const),
    wipe: vi.fn(async () => undefined),
    clearAuthLoss: vi.fn(),
    ...o,
  } as ReauthDeps & Record<keyof ReauthDeps, ReturnType<typeof vi.fn>>;
}

async function show(reauth: ReauthDeps) {
  render(<AuthPage gate="login" deps={{ api: fakeApi(), now: () => 1, onDone: vi.fn(), account: fakeAccount(), reauth }} />);
  await waitFor(() => expect(turnstile.mounted).toBe(1));
}

beforeEach(() => {
  resetHarness();
  sessionStorage.clear();
});
afterEach(cleanup);

describe('登录页：登录已过期（lemo.reauth）', () => {
  it('提示“登录已过期”和“内容都还在”；只调一次 count()；联网查一次 session_fate（用记号里的 sid、uid）', async () => {
    setExitNotice('expired');
    const d = deps();
    await show(d);
    const line = screen.getByTestId('auth-exit-notice');
    expect(line.getAttribute('data-reason')).toBe('expired');
    expect(line.textContent).toBe(zh['auth.exit.expired']);
    expect(screen.getByTestId('auth-reauth-kept').textContent).toBe(zh['auth.reauth.kept']);
    await waitFor(() => expect(d.fate).toHaveBeenCalledWith(S, A));
    expect(d.count).toHaveBeenCalledTimes(1);
    expect(d.fate).toHaveBeenCalledTimes(1);
    expect(d.wipe).not.toHaveBeenCalled();
    expect(readExitNotice()).toBeNull();
    expect(screen.queryByTestId('auth-reauth-pending')).toBeNull();
  });

  it('outbox 还有 N 条：提示 N 条没同步（只说条数、不分账号，R-387）', async () => {
    await show(deps({ count: vi.fn(async () => 3) }));
    const p = await screen.findByTestId('auth-reauth-pending');
    expect(p.textContent).toBe(zh['auth.reauth.pending'].replace('{n}', '3'));
  });

  it('离线：先不查，恢复联网再查一次', async () => {
    let fire: () => void = () => undefined;
    const d = deps({ online: vi.fn(() => false), onOnline: vi.fn((fn: () => void) => ((fire = fn), () => undefined)) });
    await show(d);
    expect(d.fate).not.toHaveBeenCalled();
    act(() => fire());
    await waitFor(() => expect(d.fate).toHaveBeenCalledTimes(1));
  });

  it('再查回 revoked：清库（被动，不删 lemo.authloss），改提示“被移除”', async () => {
    const d = deps({ fate: vi.fn(async () => 'revoked' as const) });
    await show(d);
    await waitFor(() => expect(screen.getByTestId('auth-exit-notice').getAttribute('data-reason')).toBe('removed'));
    expect(d.wipe).toHaveBeenCalledTimes(1);
    expect(d.clearAuthLoss).not.toHaveBeenCalled();
    expect(screen.queryByTestId('auth-reauth-clear')).toBeNull();
  });

  it('“清除这台设备上的内容”：先问一次，确认后清库、删 lemo.authloss，提示已清除', async () => {
    const d = deps();
    await show(d);
    fireEvent.click(screen.getByTestId('auth-reauth-clear'));
    expect(d.wipe).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-reauth-confirm')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('auth-reauth-clear-yes'));
    });
    await waitFor(() => expect(screen.getByTestId('auth-reauth-cleared').textContent).toBe(zh['auth.reauth.cleared']));
    expect(d.wipe).toHaveBeenCalledTimes(1);
    expect(d.clearAuthLoss).toHaveBeenCalledTimes(1);
  });

  it('没有记号：照旧显示 lemo.exit_notice 那条，不数 outbox、不查', async () => {
    setExitNotice('pending_deletion');
    const d = deps({ read: vi.fn(() => null) });
    await show(d);
    expect(screen.getByTestId('auth-exit-notice').getAttribute('data-reason')).toBe('pending_deletion');
    expect(d.count).not.toHaveBeenCalled();
    expect(d.fate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('auth-reauth-clear')).toBeNull();
  });

  it('已停用（负责人 11-11 定：只退出、不清本机）：显示“已停用、已退出登录”和“内容还在”，记号 session_id 为 null 不查 session_fate', async () => {
    setExitNotice('disabled');
    const d = deps({ read: vi.fn(() => ({ v: 1 as const, user_id: A, session_id: null, at: 1 })) });
    await show(d);
    const line = screen.getByTestId('auth-exit-notice');
    expect(line.getAttribute('data-reason')).toBe('disabled');
    expect(line.textContent).toBe(zh['auth.exit.disabled']);
    expect(line.textContent).not.toContain('已清除');
    expect(screen.getByTestId('auth-reauth-kept')).toBeTruthy();
    expect(screen.getByTestId('auth-reauth-clear')).toBeTruthy();
    expect(d.fate).not.toHaveBeenCalled();
    expect(d.wipe).not.toHaveBeenCalled();
  });
});
