// 登录页离开、exe 注册（架构 0.38 第 41 条、0.53）：网页版跳 /app/；exe 调不带载荷的 auth_done、auth_open_signup
import { describe, expect, it, vi } from 'vitest';
import { authDoneFailed, leaveAuthPage, openDesktopSignup, retryAuthDone, subscribeAuthDone } from '../desktop-auth.ts';

describe('leaveAuthPage', () => {
  it('网页版跳回 /app/', () => {
    const go = vi.fn();
    leaveAuthPage(undefined, go);
    expect(go).toHaveBeenCalledExactlyOnceWith('/app/');
  });

  it('exe 调 auth_done，不导航；失败也不抛', async () => {
    const go = vi.fn();
    const invoke = vi.fn(() => Promise.reject(new Error('x')));
    leaveAuthPage(invoke, go);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('auth_done');
    expect(go).not.toHaveBeenCalled();
  });

  it('auth_done 失败记下“没交接成”并通知订阅者；重试成功后清掉', async () => {
    await retryAuthDone(async () => null); // 上一条用例已经失败过一次：先清掉（状态在模块里，一页只有一份）
    const seen: boolean[] = [];
    const off = subscribeAuthDone(() => seen.push(authDoneFailed()));
    leaveAuthPage(() => Promise.reject(new Error('x')), vi.fn());
    await vi.waitFor(() => expect(authDoneFailed()).toBe(true));
    await expect(retryAuthDone(() => Promise.reject(new Error('x')))).resolves.toBe(false);
    expect(authDoneFailed()).toBe(true);
    await expect(retryAuthDone(async () => null)).resolves.toBe(true);
    expect(authDoneFailed()).toBe(false);
    expect(seen).toEqual([true, false]);
    off();
    await expect(retryAuthDone(undefined)).resolves.toBe(false);
  });
});

describe('openDesktopSignup', () => {
  it('调 auth_open_signup，不带地址', async () => {
    const invoke = vi.fn(async () => null);
    await expect(openDesktopSignup(invoke)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('auth_open_signup');
  });

  it('打不开、不在 exe 里都回 false', async () => {
    await expect(openDesktopSignup(() => Promise.reject(new Error('x')))).resolves.toBe(false);
    await expect(openDesktopSignup(undefined)).resolves.toBe(false);
  });
});
