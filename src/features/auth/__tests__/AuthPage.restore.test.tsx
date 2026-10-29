// 登录页·冷静期探测和恢复页（R-256 ③、架构 0.29 续第 131 条④、第 134 条；TC-B1-100 ①②④⑥、TC-B1-103 ②）
// 验证码通过后先探测：active、pending_deletion、disabled、try_later（unknown）四种；恢复页的恢复成功、reauth_required、保持注销三条路径；
// 本机已有会话（SessionCheck）时同样探测。验证码刚通过、探测不出（unsure 页，R-258 ①）在 AuthPage.unsure.test.tsx
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { purgeWhen, type AccountGateApi } from '../data/account-gate.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { exitSpy, fakeAccount, fakeApi, loginWith, now, renderPage, resetHarness } from './auth-page-harness.tsx';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(resetHarness);
afterEach(cleanup);

const PURGE = '2026-11-05T05:30:00.000Z';
/** 界面上的 {when}：本机时区，词条 auth.restore.when */
const whenOf = (tpl: string) => {
  const p = purgeWhen(PURGE) as unknown as Record<string, string>;
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? '');
};
const pending = { kind: 'pending_deletion' as const, purgeAfter: PURGE };


describe('验证码通过后先探测账号状态', () => {
  it('active：照常进 App', async () => {
    const account = fakeAccount();
    const { onDone } = await loginWith(account);
    expect(account.status).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('pending_deletion：不进 App，原地显示恢复页（日期按本机时区“日期 时刻”）和两个按钮，没有验证码框', async () => {
    const { onDone } = await loginWith(fakeAccount({ status: vi.fn(async () => pending) }));
    expect(onDone).not.toHaveBeenCalled();
    const when = whenOf(zh['auth.restore.when']);
    expect(screen.getByTestId('auth-restore-ask').textContent).toBe(zh['auth.restore.ask'].replace('{when}', when));
    expect(screen.getByRole('button', { name: zh['auth.restore.restore'] })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh['auth.restore.keep'] })).toBeTruthy();
    expect(screen.queryByLabelText(zh['auth.code.label'])).toBeNull();
  });

  it('purge_after 为 null：换不带日期的那句', async () => {
    await loginWith(fakeAccount({ status: vi.fn(async () => ({ kind: 'pending_deletion' as const, purgeAfter: null })) }));
    expect(screen.getByTestId('auth-restore-ask').textContent).toBe(zh['auth.restore.askNoDate']);
  });

  it('后端审查 10-30：status 回 disabled（ok:true）绝不进 App；只显示“账号已停用”，没有恢复按钮；退出本会话、清本机', async () => {
    const log: string[] = [];
    const account = fakeAccount({ status: vi.fn(async () => ({ kind: 'disabled' as const })) });
    const { onDone, api } = await loginWith(account, log);
    expect(onDone).not.toHaveBeenCalled();
    expect((await screen.findByTestId('auth-disabled')).textContent).toBe(zh['auth.exit.disabled']);
    expect(account.signOutLocal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: zh['auth.restore.restore'] })).toBeNull();
    expect(screen.queryByTestId('auth-restore-ask')).toBeNull();
    await waitFor(() => expect(log.at(-1)).toBe('clearLocalSessionIf:s1'));
    expect(log).toContain('deleteDb');
    expect(api.signOutHere).not.toHaveBeenCalled();   // 不删 devices 行
    // 审查建议 3：停用页不是死路，“回到登录”回填邮箱那一步
    fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.backToLogin'] }));
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
  });

  it('审查建议 3：退出、清本机做完以前不说“数据已清除”，只显示“请稍候…”', async () => {
    let release = (): void => undefined;
    const account = fakeAccount({
      status: vi.fn(async () => ({ kind: 'disabled' as const })),
      signOutLocal: vi.fn(() => new Promise<boolean>((r) => (release = () => r(true)))),
    });
    await loginWith(account);
    await waitFor(() => expect(account.signOutLocal).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('auth-disabled')).toBeNull();
    expect(screen.getByTestId('auth-disabled-busy').textContent).toBe(zh['auth.busy']);
    await act(async () => release());
    expect(await screen.findByTestId('auth-disabled')).toBeTruthy();
  });
});

describe('恢复页', () => {
  it('恢复成功：先清本机库，再进 App', async () => {
    const log: string[] = [];
    const account = fakeAccount({ status: vi.fn(async () => pending) });
    const { onDone } = await loginWith(account, log);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(account.restore).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['deleteDb', 'onDone']);
    expect(account.signOutLocal).not.toHaveBeenCalled();
  });

  it('reauth_required：删本会话（scope local + clearLocalSessionIf(先读的 sid)），回填邮箱那一步，提示重新收码', async () => {
    const log: string[] = [];
    const account = fakeAccount({
      status: vi.fn(async () => pending),
      restore: vi.fn(async () => ({ ok: false as const, error: 'reauth_required' as const })),
    });
    const { onDone, api } = await loginWith(account, log);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(account.signOutLocal).toHaveBeenCalledTimes(1);
    expect(api.signOutHere).not.toHaveBeenCalled();
    expect(log.at(-1)).toBe('clearLocalSessionIf:s1');
    expect(screen.getByTestId('auth-gate-exit').textContent).toBe(zh['auth.restore.reauth']);
    expect((screen.getByLabelText(zh['auth.email.label']) as HTMLInputElement).value).toBe('me@example.com');
  });

  it('保持注销并退出：scope local 退出、再 clearLocalSessionIf(sid)，不删 devices 行；回登录表单', async () => {
    const log: string[] = [];
    const account = fakeAccount({ status: vi.fn(async () => pending) });
    const { onDone, api } = await loginWith(account, log);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.keep'] }));
    });
    expect(account.restore).not.toHaveBeenCalled();
    expect(account.signOutLocal).toHaveBeenCalledTimes(1);
    expect(api.signOutHere).not.toHaveBeenCalled();
    expect(log.at(-1)).toBe('clearLocalSessionIf:s1');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-gate-exit').textContent).toBe(zh['auth.exit.pendingDeletion']);
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
  });

  it('restore_too_late：提示“已开始删除”，恢复按钮收起；rate_limited 提示明天再试、按钮还在', async () => {
    const restore = vi.fn(async () => ({ ok: false as const, error: 'rate_limited' as const }));
    await loginWith(fakeAccount({ status: vi.fn(async () => pending), restore }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(screen.getByTestId('auth-restore-error').textContent).toBe(zh['auth.restore.err.rateLimited']);
    restore.mockResolvedValueOnce({ ok: false, error: 'restore_too_late' } as never);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(screen.getByTestId('auth-restore-error').textContent).toBe(zh['auth.restore.err.tooLate']);
    expect(screen.queryByRole('button', { name: zh['auth.restore.restore'] })).toBeNull();
    expect(screen.getByRole('button', { name: zh['auth.restore.keep'] })).toBeTruthy();
  });

  it('restore 回 account_disabled（冷静期里又被停用）：改显示“账号已停用”', async () => {
    const account = fakeAccount({
      status: vi.fn(async () => pending),
      restore: vi.fn(async () => ({ ok: false as const, error: 'account_disabled' as const })),
    });
    await loginWith(account);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(await screen.findByTestId('auth-disabled')).toBeTruthy();
    expect(account.signOutLocal).toHaveBeenCalledTimes(1);
  });

  it('韩文界面：恢复页文案和按钮是韩文', async () => {
    act(() => uiStore.getState().setLocale('ko-KR'));
    const onDone = vi.fn();
    await renderPage(fakeApi(), onDone, fakeAccount({ status: vi.fn(async () => pending) }));
    fireEvent.change(screen.getByLabelText(ko['auth.email.label']), { target: { value: 'me@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ko['auth.email.send'] }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(ko['auth.code.label']), { target: { value: '123456' } });
    });
    const when = whenOf(ko['auth.restore.when']);
    expect(screen.getByTestId('auth-restore-ask').textContent).toBe(ko['auth.restore.ask'].replace('{when}', when));
    expect(screen.getByRole('button', { name: ko['auth.restore.restore'] })).toBeTruthy();
    expect(screen.getByRole('button', { name: ko['auth.restore.keep'] })).toBeTruthy();
  });
});

describe('本机已有会话（SessionCheck）也探测一次', () => {
  const USER = '0e2e0000-0000-4000-8000-000000000001';
  const renderSigned = (account: AccountGateApi, onDone = vi.fn(), log: string[] = []) => {
    render(<AuthPage gate="login" deps={{ api: fakeApi(), now, onDone, account, readUserId: () => USER, localExit: exitSpy(log) }} />);
    return onDone;
  };

  it('R-258 ②：探测不出（unknown）不挡，照旧显示“当前已登录”，“回到 App”能用（离线也能用）', async () => {
    const account = fakeAccount({ status: vi.fn(async () => ({ kind: 'unknown' as const })) });
    const onDone = renderSigned(account);
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('auth-unsure')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: zh['auth.session.backToApp'] }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('active：照旧显示“当前已登录”', async () => {
    const account = fakeAccount();
    renderSigned(account);
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('auth-signed-in')).toBeTruthy();
  });

  it('pending_deletion：显示恢复页；恢复成功先清库、再回 App', async () => {
    const log: string[] = [];
    const account = fakeAccount({ status: vi.fn(async () => pending) });
    const onDone = renderSigned(account, vi.fn(() => void log.push('onDone')), log);
    await screen.findByTestId('auth-restore');
    expect(screen.queryByTestId('auth-signed-in')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['deleteDb', 'onDone']);
  });

  it('pending_deletion 再点“保持注销并退出”：出登录表单和冷静期提示', async () => {
    const log: string[] = [];
    const account = fakeAccount({ status: vi.fn(async () => pending) });
    renderSigned(account, vi.fn(), log);
    await screen.findByTestId('auth-restore');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.keep'] }));
    });
    expect(log.at(-1)).toBe('clearLocalSessionIf:s1');
    expect(screen.getByTestId('auth-gate-exit').textContent).toBe(zh['auth.exit.pendingDeletion']);
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
  });

  it('disabled：只显示“账号已停用”，不出“回到 App”', async () => {
    const account = fakeAccount({ status: vi.fn(async () => ({ kind: 'disabled' as const })) });
    renderSigned(account);
    expect((await screen.findByTestId('auth-disabled')).textContent).toBe(zh['auth.exit.disabled']);
    expect(screen.queryByRole('button', { name: zh['auth.session.backToApp'] })).toBeNull();
    expect(account.signOutLocal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.backToLogin'] }));
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
  });
});
