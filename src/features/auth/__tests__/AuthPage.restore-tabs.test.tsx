// 登录页·恢复页遇上多标签页（TC-B1-100b；审查必改 2；参考 settings 的 exit-sid.test.tsx）：
// TC-B1-100b 各步：① ② ⑤ ⑥ 在“SessionCheck 的恢复页”，③ ④ 在“验证码刚通过的恢复页”（见各 it 标题开头的编号）
// 标签页 1 显示 A 的恢复页 → 标签页 2 登录了 B → 回到标签页 1 点“保持注销并退出”/“恢复账号”，或 restore 回 reauth_required。
// 要求：不调 supabase-js signOut、不删库、不删本机会话（B 的）、不调 restore；要退出的用探测时记下的 A 的旧令牌直接 /logout；然后整页重走 SessionCheck
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus, RestoreResult } from '../data/account-gate.ts';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { fakeAccount, fakeApi, now, resetHarness, typeEmailAndSend } from './auth-page-harness.tsx';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

const A = { sid: 's-a', user: '0e2e0000-0000-4000-8000-00000000000a', token: 'tok-a' };
const B = { sid: 's-b', user: '0e2e0000-0000-4000-8000-00000000000b', token: 'tok-b' };
const NONE = { sid: null, user: null, token: null };
/** 本机 localStorage 里现在是谁（别的标签页登录就改它） */
let cur: { sid: string | null; user: string | null; token: string | null } = A;

beforeEach(() => {
  resetHarness();
  cur = A;
});
afterEach(cleanup);

const pending: AccountStatus = { kind: 'pending_deletion', purgeAfter: '2026-11-05T05:30:00.000Z' };

function setup(status: () => Promise<AccountStatus>, restore?: () => Promise<RestoreResult>, verifySetsTo = A) {
  const log: string[] = [];
  const account = fakeAccount({ status: vi.fn(status), ...(restore ? { restore: vi.fn(restore) } : {}) });
  const logoutWithToken = vi.fn(async (token: string) => {
    log.push(`logout:${token}`);
    return { serverDone: true };
  });
  const localExit = {
    clearLocalSessionIf: vi.fn((sid: string | null) => void log.push(`clearLocalSessionIf:${sid}`)),
    readSessionId: () => cur.sid,
    deleteDb: vi.fn(async () => {
      log.push('deleteDb');
      return 'deleted' as const;
    }),
    clearCacheStorage: vi.fn(async () => void log.push('clearCacheStorage')),
  };
  const api = fakeApi({
    verifyCode: vi.fn(async () => {
      cur = verifySetsTo;
      return { ok: true as const, value: undefined };
    }),
  });
  const onDone = vi.fn(() => void log.push('onDone'));
  render(
    <AuthPage
      gate="login"
      deps={{
        api, now, onDone, account, localExit, logoutWithToken,
        readUserId: () => cur.user, readToken: () => cur.token, readEmail: () => null, watchSession: () => () => undefined,
      }}
    />,
  );
  return { log, account, logoutWithToken, localExit, onDone };
}

/** 第二次起 status 回 active（B 的账号） */
const pendingThenActive = () => {
  let n = 0;
  return async (): Promise<AccountStatus> => (n++ === 0 ? pending : { kind: 'active' });
};

describe('SessionCheck 的恢复页：点按钮前本机会话已换成 B', () => {
  it('TC-B1-100b ①“保持注销并退出”：不调 signOut、不删库、不删本机会话；用 A 的旧令牌 /logout；重走 SessionCheck（按 B 再探测）', async () => {
    const { log, account } = setup(pendingThenActive());
    await screen.findByTestId('auth-restore');
    cur = B;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.keep'] }));
    });
    expect(account.signOutLocal).not.toHaveBeenCalled();
    expect(log).toEqual(['logout:tok-a']);
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('auth-signed-in')).toBeTruthy();
  });

  it('TC-B1-100b ②“恢复账号”：不调 restore、不 /logout、不删库；重走一遍探测', async () => {
    const { log, account } = setup(pendingThenActive());
    await screen.findByTestId('auth-restore');
    cur = B;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(account.restore).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('auth-signed-in')).toBeTruthy();
  });

  it('TC-B1-100b ⑥ 复审建议 2：A 已在别的标签页退出（本机 sid 读到 null）：照常清本机库和缓存，再用旧令牌 /logout，显示冷静期提示', async () => {
    const { log, account } = setup(pendingThenActive());
    await screen.findByTestId('auth-restore');
    localStorage.setItem(`lemo.logq.${A.user}`, '[]');
    cur = NONE;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.keep'] }));
    });
    expect(account.signOutLocal).not.toHaveBeenCalled();
    expect(log).toEqual(['deleteDb', 'clearCacheStorage', 'logout:tok-a']);
    expect(account.status).toHaveBeenCalledTimes(1);   // 不重走探测
    expect(localStorage.getItem(`lemo.logq.${A.user}`)).toBeNull();   // 复审小建议 2：A 没传完的日志队列一并清掉
    expect(screen.getByTestId('auth-gate-exit').textContent).toBe(zh['auth.exit.pendingDeletion']);
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
  });

  it('TC-B1-100b ① 补充，复审小建议 1：sid 读不到但 user_id 还读得到，按“换了”处理：不清库，用旧令牌 /logout、重走 SessionCheck', async () => {
    const { log, account } = setup(pendingThenActive());
    await screen.findByTestId('auth-restore');
    cur = { sid: null, user: A.user, token: null };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.keep'] }));
    });
    expect(account.signOutLocal).not.toHaveBeenCalled();
    expect(log).toEqual(['logout:tok-a']);
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(2));
  });

  it('TC-B1-100b ⑤ 对照：会话没换时照常退出（signOut local、删库、按 A 的 sid 删本机会话），不走旧令牌', async () => {
    const { log, account } = setup(pendingThenActive());
    await screen.findByTestId('auth-restore');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.keep'] }));
    });
    expect(account.signOutLocal).toHaveBeenCalledTimes(1);
    expect(log).toContain('deleteDb');
    expect(log.at(-1)).toBe('clearLocalSessionIf:s-a');
    expect(log).not.toContain('logout:tok-a');
  });
});

describe('验证码刚通过的恢复页：restore 进行中本机会话换成 B', () => {
  async function loginAsA(status: () => Promise<AccountStatus>, restore: () => Promise<RestoreResult>) {
    cur = NONE;
    const r = setup(status, restore, A);
    await typeEmailAndSend('a@example.com');
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '123456' } });
    });
    await screen.findByTestId('auth-restore');
    return r;
  }

  it('TC-B1-100b ③ restore 回 reauth_required：不调 signOut、不删库、不删 B 的会话；用 A 的旧令牌 /logout；重走 SessionCheck', async () => {
    const { log, account, onDone } = await loginAsA(pendingThenActive(), async () => {
      cur = B;   // restore 在路上时，别的标签页登录了 B
      return { ok: false, error: 'reauth_required' };
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(account.signOutLocal).not.toHaveBeenCalled();
    expect(log).toEqual(['logout:tok-a']);
    expect(onDone).not.toHaveBeenCalled();
    expect(await screen.findByTestId('auth-signed-in')).toBeTruthy();
  });

  it('TC-B1-100b ④ restore 成功、但回来时本机已是 B：不删库（那是 B 的），不进 App，重走 SessionCheck', async () => {
    const { log, onDone } = await loginAsA(pendingThenActive(), async () => {
      cur = B;
      return { ok: true };
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.restore.restore'] }));
    });
    expect(log).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
    expect(await screen.findByTestId('auth-signed-in')).toBeTruthy();
  });
});
