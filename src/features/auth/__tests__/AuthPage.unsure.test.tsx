// 登录页·验证码刚通过、探测不出账号状态（R-258 ①；复审必改、复审建议 1）：不进 App、不清本机，出“暂时无法确认账号状态”，
// “重试”重新探测（进行中面板留着，不露出验证码框）、查出 disabled 时等清理做完才说“数据已清除”，“仍然进入”照旧进 App。
// SessionCheck 遇到 unknown 不挡（R-258 ②）在 AuthPage.restore.test.tsx
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../data/account-gate.ts';
import { zh } from '../i18n/zh.ts';
import { fakeAccount, loginWith, resetHarness } from './auth-page-harness.tsx';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(resetHarness);
afterEach(cleanup);

describe('验证码通过后探测不出（unknown）', () => {
  it('R-258 ①：探测不出（unknown：超时、断网、503、回包认不出）不进 App，出“暂时无法确认”和两个按钮，不清本机', async () => {
    const log: string[] = [];
    const account = fakeAccount({ status: vi.fn(async () => ({ kind: 'unknown' as const })) });
    const { onDone } = await loginWith(account, log);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-unsure').textContent).toContain(zh['auth.gate.unsure']);
    expect(screen.getByRole('button', { name: zh['auth.gate.retry'] })).toBeTruthy();
    expect(log).toEqual([]);
    expect(account.signOutLocal).not.toHaveBeenCalled();
  });

  it('R-258 ①：“重试”重新探测，这次 active 就进 App', async () => {
    const status = vi.fn(async () => ({ kind: 'unknown' as const }) as { kind: 'unknown' } | { kind: 'active' });
    const { onDone } = await loginWith(fakeAccount({ status }));
    status.mockResolvedValueOnce({ kind: 'active' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.retry'] }));
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('复审建议 1：重试进行中 unsure 面板留着，不退回验证码那一步（不能再提交用过的验证码）', async () => {
    let answer = (_s: { kind: 'active' }): void => undefined;
    const status = vi.fn(async () => ({ kind: 'unknown' as const }) as { kind: 'unknown' } | { kind: 'active' });
    const { onDone } = await loginWith(fakeAccount({ status }));
    status.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.retry'] }));
    });
    expect(screen.getByTestId('auth-unsure')).toBeTruthy();
    expect(screen.queryByLabelText(zh['auth.code.label'])).toBeNull();
    await act(async () => answer({ kind: 'active' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('复审必改：重试后查出 disabled，退出、清本机做完以前只显示“请稍候…”，做完才说“数据已清除”', async () => {
    let release = (): void => undefined;
    const status = vi.fn(async () => ({ kind: 'unknown' as const }) as { kind: 'unknown' } | { kind: 'disabled' });
    const account = fakeAccount({ status, signOutLocal: vi.fn(() => new Promise<boolean>((r) => (release = () => r(true)))) });
    await loginWith(account);
    status.mockResolvedValueOnce({ kind: 'disabled' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.retry'] }));
    });
    await waitFor(() => expect(account.signOutLocal).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('auth-disabled')).toBeNull();
    expect(screen.getByTestId('auth-disabled-busy').textContent).toBe(zh['auth.busy']);
    await act(async () => release());
    expect(await screen.findByTestId('auth-disabled')).toBeTruthy();
  });

  it('R-258 ①：重试还是不行就留在这一页；“仍然进入”照旧进 App，不清本机', async () => {
    const log: string[] = [];
    const account = fakeAccount({ status: vi.fn(async () => ({ kind: 'unknown' as const })) });
    const { onDone } = await loginWith(account, log);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.retry'] }));
    });
    expect(screen.getByTestId('auth-unsure')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.enterAnyway'] }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['onDone']);
  });

  it('复审小建议 3：quiet 重试查出 pending_deletion：显示恢复页，两个按钮能点', async () => {
    const status = vi.fn(async () => ({ kind: 'unknown' as const }) as AccountStatus);
    const account = fakeAccount({ status });
    const { onDone } = await loginWith(account);
    status.mockResolvedValueOnce({ kind: 'pending_deletion', purgeAfter: null });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.gate.retry'] }));
    });
    expect(screen.getByTestId('auth-restore-ask').textContent).toBe(zh['auth.restore.askNoDate']);
    const restore = screen.getByRole('button', { name: zh['auth.restore.restore'] });
    expect(restore).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: zh['auth.restore.keep'] })).toHaveProperty('disabled', false);
    await act(async () => {
      fireEvent.click(restore);
    });
    expect(account.restore).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
