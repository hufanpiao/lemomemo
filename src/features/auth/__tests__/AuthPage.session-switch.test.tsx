// 登录页·已登录时别的标签页换了账号或退出（K6-auth-switch 审查建议；架构 0.38 第 35 条、4.1）：
// 提示跟着会话变化刷新；点“退出并换账号”时再核对一次 user_id，和显示的不一样就只刷新提示、不退出（免得看着 A 退掉 B）
// 已登录时的其他行为在 AuthPage.session.test.tsx；共用的假接口在 auth-page-harness.tsx，假 Turnstile 在 turnstile-fake.ts
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { fakeApi, now, resetHarness } from './auth-page-harness.tsx';
import { turnstile } from './turnstile-fake.ts';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(resetHarness);
afterEach(cleanup);

const USER = '0e2e0000-0000-4000-8000-000000000001';
const OTHER = '0e2e0000-0000-4000-8000-000000000002';

/** 本机清理的替身（记先后） */
function exitSpy(log: string[]) {
  return {
    clearLocalSessionIf: vi.fn((_sid: string | null) => void log.push('clearLocalSession')),
    readSessionId: () => 's1',
    deleteDb: vi.fn(async () => {
      log.push('deleteDb');
      return 'deleted' as const;
    }),
    clearCacheStorage: vi.fn(async () => void log.push('clearCacheStorage')),
  };
}

describe('别的标签页换了账号（K6-auth-switch 审查建议）', () => {
  /** 可控的本机会话 + 假的 storage 事件 */
  function session(userId: string | null, email: string | null) {
    const s = { userId, email, fire: () => undefined as void, unsub: vi.fn() };
    const watchSession = vi.fn((fn: () => void) => {
      s.fire = fn;
      return s.unsub;
    });
    return { s, deps: { readUserId: () => s.userId, readEmail: () => s.email, watchSession } };
  }

  it('会话变成 B：提示换成 B 的邮箱；卸载时取消监听', () => {
    const { s, deps } = session(USER, 'a@example.com');
    const { unmount } = render(<AuthPage gate="login" deps={{ api: fakeApi(), now, onDone: vi.fn(), localExit: exitSpy([]), ...deps }} />);
    expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 a@example.com，要换账号请先退出');
    s.userId = OTHER;
    s.email = 'b@example.com';
    act(() => s.fire());
    expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 b@example.com，要换账号请先退出');
    expect(screen.queryByTestId('auth-session-changed')).toBeNull();
    unmount();
    expect(s.unsub).toHaveBeenCalledTimes(1);
  });

  it('默认监听就是 storage 事件（platform 的 onSessionStorageChange）', () => {
    let userId: string | null = USER;
    let email: string | null = 'a@example.com';
    render(<AuthPage gate="login" deps={{ api: fakeApi(), now, onDone: vi.fn(), localExit: exitSpy([]), readUserId: () => userId, readEmail: () => email }} />);
    userId = OTHER;
    email = 'b@example.com';
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 b@example.com，要换账号请先退出');
  });

  it('别的页面退出了（会话没了）：直接出登录表单', async () => {
    const { s, deps } = session(USER, 'a@example.com');
    render(<AuthPage gate="login" deps={{ api: fakeApi(), now, onDone: vi.fn(), localExit: exitSpy([]), ...deps }} />);
    s.userId = null;
    s.email = null;
    act(() => s.fire());
    expect(screen.queryByTestId('auth-signed-in')).toBeNull();
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
    await waitFor(() => expect(turnstile.mounted).toBe(1));
  });

  it('没登录时别的页面登录了：改成“当前已登录”提示', () => {
    const { s, deps } = session(null, null);
    render(<AuthPage gate="login" deps={{ api: fakeApi(), now, onDone: vi.fn(), localExit: exitSpy([]), ...deps }} />);
    s.userId = OTHER;
    s.email = 'b@example.com';
    act(() => s.fire());
    expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 b@example.com，要换账号请先退出');
  });

  it('点击时会话已是 B（storage 事件没赶上）：只刷新提示、说明一句，不退出；再点一次才退出', async () => {
    const { s, deps } = session(USER, 'a@example.com');
    const log: string[] = [];
    const localExit = exitSpy(log);
    const api = fakeApi();
    render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), localExit, ...deps }} />);
    s.userId = OTHER;
    s.email = 'b@example.com';
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
    });
    expect(api.signOutHere).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 b@example.com，要换账号请先退出');
    expect(screen.getByTestId('auth-session-changed').textContent).toBe(zh['auth.session.changed']);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
    });
    expect(api.signOutHere).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText(zh['auth.email.label'])).toBeTruthy();
  });

  it('点击时会话已经没了：不退出，直接出登录表单', async () => {
    const { s, deps } = session(USER, 'a@example.com');
    const log: string[] = [];
    const api = fakeApi();
    render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), localExit: exitSpy(log), ...deps }} />);
    s.userId = null;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
    });
    expect(api.signOutHere).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
    expect(screen.queryByTestId('auth-server-pending')).toBeNull();
  });

  it('退出那几秒里别的标签页登录了 B：退出完成后重读会话，显示“当前已登录 B”，不出登录表单', async () => {
    const { s, deps } = session(USER, 'a@example.com');
    let release: () => void = () => undefined;
    const api = fakeApi({
      signOutHere: vi.fn(() => new Promise<{ ok: true; value: undefined }>((r) => (release = () => r({ ok: true, value: undefined })))),
    });
    render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), localExit: exitSpy([]), ...deps }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
    });
    s.userId = OTHER;
    s.email = 'b@example.com';
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 b@example.com，要换账号请先退出'));
    expect(screen.getByRole('button', { name: zh['auth.session.switch'] })).toHaveProperty('disabled', false);
    expect(screen.queryByLabelText(zh['auth.email.label'])).toBeNull();
    expect(turnstile.mounted).toBe(0);
  });

  it('退出进行中收到会话变化：不理会，提示和按钮不动；退出做完重读会话才换', async () => {
    const { s, deps } = session(USER, 'a@example.com');
    let release: () => void = () => undefined;
    const api = fakeApi({
      signOutHere: vi.fn(() => new Promise<{ ok: true; value: undefined }>((r) => (release = () => r({ ok: true, value: undefined })))),
    });
    render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), localExit: exitSpy([]), ...deps }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
    });
    s.userId = OTHER;
    s.email = 'b@example.com';
    act(() => s.fire());
    expect(screen.getByRole('button', { name: zh['auth.busy'] })).toHaveProperty('disabled', true);
    expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 a@example.com，要换账号请先退出');
    await act(async () => {
      release();
    });
    // 退出做完以后才重读会话（上一条），这时才换成 B
    await waitFor(() => expect(screen.getByTestId('auth-signed-in').textContent).toBe('当前已登录 b@example.com，要换账号请先退出'));
  });
});
