// 恢复页审查留下的建议（GATE-sugg ①②⑥）：
// ① SessionCheck 按 user_id 记下探测过的账号：别的标签页把会话换成另一个账号后，按新账号再探测（不重挂，“会话已换”提示留着）
// ② 显示恢复页的退出提示（gateExit）时 ExitNoticeLine 不挂，也要把存着的退出原因删掉
// ⑥ auth.restore.err.tooLate 补主语
// 第八轮必改 2：A 的探测晚于 B 回来，结果丢掉
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readExitNotice, setExitNotice } from '../../../platform/session.ts';
import type { AccountStatus } from '../data/account-gate.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { exitSpy, fakeAccount, fakeApi, loginWith, now, resetHarness } from './auth-page-harness.tsx';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

const A = '0e2e0000-0000-4000-8000-00000000000a';
const B = '0e2e0000-0000-4000-8000-00000000000b';
const pending: AccountStatus = { kind: 'pending_deletion', purgeAfter: null };

beforeEach(() => {
  resetHarness();
  sessionStorage.clear();
});
afterEach(cleanup);

/** 已登录 A 打开登录页；fire = 别的标签页改了会话（storage 事件） */
function signedIn(status: (n: number) => Promise<AccountStatus>) {
  const s = { userId: A as string | null, email: 'a@example.com' as string | null, fire: () => undefined as void };
  let n = 0;
  const account = fakeAccount({ status: vi.fn(() => status(n++)) });
  const watchSession = (fn: () => void) => {
    s.fire = fn;
    return () => undefined;
  };
  render(
    <AuthPage
      gate="login"
      deps={{ account, api: fakeApi(), now, onDone: vi.fn(), localExit: exitSpy([]), readUserId: () => s.userId, readEmail: () => s.email, watchSession }}
    />,
  );
  return { s, account };
}

describe('① SessionCheck 按 user_id 重新探测', () => {
  it('A 在冷静期（恢复页）→ 别的标签页换成 B：按 B 再探测；B 正常就回到“当前已登录 B”', async () => {
    const { s, account } = signedIn(async (n) => (n === 0 ? pending : { kind: 'active' }));
    await screen.findByTestId('auth-restore');
    s.userId = B;
    s.email = 'b@example.com';
    act(() => s.fire());
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('auth-signed-in')).toBeTruthy();
    expect(screen.queryByTestId('auth-restore')).toBeNull();
  });

  it('A 正常 → 换成 B（B 在冷静期）：出 B 的恢复页；同一个账号再收到 storage 事件不重复探测', async () => {
    const { s, account } = signedIn(async (n) => (n === 0 ? { kind: 'active' } : pending));
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(1));
    act(() => s.fire());
    expect(account.status).toHaveBeenCalledTimes(1);
    s.userId = B;
    act(() => s.fire());
    expect(await screen.findByTestId('auth-restore')).toBeTruthy();
    expect(account.status).toHaveBeenCalledTimes(2);
  });
});

describe('第八轮必改 2：探测结果晚到时丢弃', () => {
  it('A 的探测还没回来时换成 B → B 回 active → A 才回 pending：不出恢复页，仍是“当前已登录 B”', async () => {
    let releaseA: (v: AccountStatus) => void = () => undefined;
    const aDone = new Promise<AccountStatus>((r) => (releaseA = r));
    const { s, account } = signedIn((n) => (n === 0 ? aDone : Promise.resolve({ kind: 'active' })));
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(1));
    s.userId = B;
    s.email = 'b@example.com';
    act(() => s.fire());
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('auth-signed-in')).toBeTruthy();
    await act(async () => {
      releaseA(pending);
      await aDone;
    });
    expect(screen.queryByTestId('auth-restore')).toBeNull();
    expect(screen.getByTestId('auth-signed-in')).toBeTruthy();
  });
});

describe('② 显示恢复页的退出提示时也删掉存着的退出原因', () => {
  it('验证码通过后出恢复页 → 期间记下过一条退出原因 → 点“保持注销并退出”：显示恢复页的提示，存着的那条删掉', async () => {
    await loginWith(fakeAccount({ status: vi.fn(async () => pending) }));
    setExitNotice('disabled');
    expect(readExitNotice()).toBe('disabled');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.keep'] }));
    });
    expect(screen.getByTestId('auth-gate-exit').textContent).toBe(zh['auth.exit.pendingDeletion']);
    expect(screen.queryByTestId('auth-exit-notice')).toBeNull();
    expect(readExitNotice()).toBeNull();
  });
});

describe('⑥ tooLate 补主语', () => {
  it('中韩都说是“账号”已开始删除', () => {
    expect(zh['auth.restore.err.tooLate']).toBe('账号已开始删除，无法恢复。');
    expect(ko['auth.restore.err.tooLate']).toContain('계정');
  });
});
