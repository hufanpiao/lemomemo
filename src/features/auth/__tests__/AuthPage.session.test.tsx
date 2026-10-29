// 登录页·已登录先退出（安全审查 9、架构 0.38 第 35 条、4.1）：提示与两个按钮、退出三步的先后、总超时、晚到处理、抛异常兜底
// 登录部分在 AuthPage.test.tsx，邀请注册在 AuthPage.invite.test.tsx；共用的假接口在 auth-page-harness.tsx，假 Turnstile 在 turnstile-fake.ts
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGN_OUT_TIMEOUT_MS } from '../hooks/useSessionGate.ts';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { fakeApi, now, resetHarness, type FakeApi } from './auth-page-harness.tsx';
import { turnstile } from './turnstile-fake.ts';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(resetHarness);
afterEach(cleanup);

describe('已登录的人打开登录页（安全审查 9、架构 0.38 第 35 条、4.1）', () => {
  const USER = '0e2e0000-0000-4000-8000-000000000001';
  const OTHER = '0e2e0000-0000-4000-8000-000000000002';

  /** 记下本机清理每一步的先后；clearLocalSession 是 K6 的 platform 函数的替身 */
  function exitSpy(log: string[]) {
    return {
      clearLocalSession: vi.fn(() => void log.push('clearLocalSession')),
      deleteDb: vi.fn(async () => {
        log.push('deleteDb');
        return 'deleted' as const;
      }),
      clearCacheStorage: vi.fn(async () => void log.push('clearCacheStorage')),
    };
  }

  it('readSessionUserId 有值：说“当前已登录，要换账号请先退出”，不出登录表单、不加载 Turnstile；“回到 App”回去、不退出', () => {
    const api = fakeApi();
    const onDone = vi.fn();
    const localExit = exitSpy([]);
    render(<AuthPage gate="login" deps={{ api, now, onDone, readUserId: () => USER, localExit }} />);
    expect(screen.getByTestId('auth-signed-in').textContent).toBe(zh['auth.session.signedIn']);
    expect(screen.queryByLabelText(zh['auth.email.label'])).toBeNull();
    expect(turnstile.mounted).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: zh['auth.session.backToApp'] }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(api.signOutHere).not.toHaveBeenCalled();
    expect(localExit.deleteDb).not.toHaveBeenCalled();
  });

  it('readSessionUserId 为 null：直接出登录表单', async () => {
    render(<AuthPage gate="login" deps={{ api: fakeApi(), now, onDone: vi.fn(), readUserId: () => null }} />);
    expect(screen.queryByTestId('auth-signed-in')).toBeNull();
    expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
    await waitFor(() => expect(turnstile.mounted).toBe(1));
  });

  for (const [name, result, want] of [
    ['服务器退出 ok：不用兜底', { ok: true as const, value: undefined }, ['signOutHere', 'deleteDb', 'clearCacheStorage']],
    ['服务器退出断网：先兜底清本机会话', { ok: false as const, error: 'offline' as const }, ['signOutHere', 'clearLocalSession', 'deleteDb', 'clearCacheStorage']],
    ['服务器退出出别的错：同样兜底', { ok: false as const, error: 'unknown' as const }, ['signOutHere', 'clearLocalSession', 'deleteDb', 'clearCacheStorage']],
  ] as const) {
    it(`“退出并换账号”：服务器退出 → 清本机库和缓存 → 才出登录表单（${name}）`, async () => {
      const log: string[] = [];
      const api = fakeApi({
        signOutHere: vi.fn(async () => {
          log.push('signOutHere');
          return result;
        }),
      });
      render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), readUserId: () => USER, localExit: exitSpy(log) }} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
      });
      expect(log).toEqual(want);
      expect(await screen.findByLabelText(zh['auth.email.label'])).toBeTruthy();
      await waitFor(() => expect(turnstile.mounted).toBe(1));
    });
  }

  it('服务器退出一直不返回：过了总超时按“不是 ok”处理，照样兜底清会话、清本机，出登录表单（K4 追加项复审必改）', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const api = fakeApi({ signOutHere: vi.fn(() => new Promise<never>(() => undefined)) });
      render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), readUserId: () => USER, localExit: exitSpy(log) }} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS - 1);
      });
      expect(log).toEqual([]);
      expect(screen.getByRole('button', { name: zh['auth.busy'] })).toHaveProperty('disabled', true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(log).toEqual(['clearLocalSession', 'deleteDb', 'clearCacheStorage']);
      expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  for (const [how, impl] of [
    ['同步抛出', () => {
      throw new Error('boom');
    }],
    ['异步 reject', () => Promise.reject(new Error('boom'))],
  ] as const) {
    it(`signOutHere 抛异常（${how}）：按“不是 ok”走兜底清理，出登录表单`, async () => {
      const log: string[] = [];
      const api = fakeApi({ signOutHere: vi.fn(impl) as unknown as FakeApi['signOutHere'] });
      render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), readUserId: () => USER, localExit: exitSpy(log) }} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
      });
      expect(log).toEqual(['clearLocalSession', 'deleteDb', 'clearCacheStorage']);
      expect(await screen.findByLabelText(zh['auth.email.label'])).toBeTruthy();
    });
  }

  for (const [name, after, clears] of [
    ['本机会话还是退出前的 user_id（旧会话被刷新写回）：再清一次', USER, 2],
    ['本机会话已是别的 user_id：不动', OTHER, 1],
    ['本机已经没有会话：不动', null, 1],
  ] as const) {
    it(`超时以后请求才回来——${name}；超时时的兜底只做一次，界面不再变`, async () => {
      vi.useFakeTimers();
      try {
        let current: string | null = USER;
        let late: (r: { ok: true; value: undefined }) => void = () => undefined;
        const log: string[] = [];
        const localExit = exitSpy(log);
        const api = fakeApi({ signOutHere: vi.fn(() => new Promise<{ ok: true; value: undefined }>((r) => (late = r))) });
        render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), readUserId: () => current, localExit }} />);
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
        });
        expect(log).toEqual(['clearLocalSession', 'deleteDb', 'clearCacheStorage']);
        const main = document.querySelector('main[data-feature="auth"]') as HTMLElement;
        expect(main.dataset['step']).toBe('email');

        current = after;
        await act(async () => {
          late({ ok: true, value: undefined });
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(localExit.clearLocalSession).toHaveBeenCalledTimes(clears);
        expect(localExit.deleteDb).toHaveBeenCalledTimes(1);
        expect(localExit.clearCacheStorage).toHaveBeenCalledTimes(1);
        expect((document.querySelector('main[data-feature="auth"]') as HTMLElement).dataset['step']).toBe('email');
        expect(screen.getByLabelText(zh['auth.email.label'])).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('请求在超时之前回来：不做晚到处理', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const localExit = exitSpy(log);
      render(<AuthPage gate="login" deps={{ api: fakeApi(), now, onDone: vi.fn(), readUserId: () => USER, localExit }} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS * 2);
      });
      expect(localExit.clearLocalSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('退出进行中：两个按钮都不能点，主按钮显示“请稍候…”', async () => {
    let release: () => void = () => undefined;
    const api = fakeApi({
      signOutHere: vi.fn(
        () =>
          new Promise<{ ok: true; value: undefined }>((r) => {
            release = () => r({ ok: true, value: undefined });
          }),
      ),
    });
    render(<AuthPage gate="login" deps={{ api, now, onDone: vi.fn(), readUserId: () => USER, localExit: exitSpy([]) }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.session.switch'] }));
    });
    expect(screen.getByRole('button', { name: zh['auth.busy'] })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: zh['auth.session.backToApp'] })).toHaveProperty('disabled', true);
    await act(async () => {
      release();
    });
    expect(await screen.findByLabelText(zh['auth.email.label'])).toBeTruthy();
  });
});
