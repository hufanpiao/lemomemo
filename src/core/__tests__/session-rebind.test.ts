// 重新验证邮箱后交接设备行（core/session-rebind.ts；B5 S3；TC-B1-86 客户端那一半：桩替主客户端、一次性客户端和 account）
import { describe, expect, it, vi } from 'vitest';
import { createSessionRebind, rebindErrOf, type EphemeralAuth, type MainAuth } from '../session-rebind.ts';

const S1 = { access_token: 'old-access', refresh_token: 'old-refresh' };
const S2 = { access_token: 'new-access', refresh_token: 'new-refresh' };

function make(o: { account?: () => Response | Promise<Response>; verify?: EphemeralAuth['verifyOtp']; refreshError?: unknown } = {}) {
  const main: MainAuth = {
    refreshSession: vi.fn(async () => (o.refreshError ? { data: { session: null }, error: o.refreshError } : { data: { session: S1 }, error: null })),
    setSession: vi.fn(async () => ({ error: null })),
  };
  const eph: EphemeralAuth = {
    signInWithOtp: vi.fn(async () => ({ error: null })),
    verifyOtp: o.verify ?? vi.fn(async () => ({ data: { session: S2 }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  const fetch = vi.fn(async (_u: string, _i: RequestInit) => (o.account ? o.account() : new Response('{"ok":true}', { status: 200 })));
  const r = createSessionRebind({ main: async () => main, ephemeral: async () => eph, fetch, accountUrl: 'https://x/functions/v1/account', anonKey: 'anon' });
  return { r, main, eph, fetch };
}

describe('verifyAndRebind', () => {
  it('成功：refresh 拿 S1 → 一次性客户端验码拿 S2 → 带 S2 调 rebind_device（old_token = S1）→ 主客户端换上 S2', async () => {
    const { r, main, fetch } = make();
    expect(await r.verifyAndRebind('a@b.c', '123456', 'dev-1')).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://x/functions/v1/account');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer new-access');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'rebind_device', device_id: 'dev-1', old_token: 'old-access' });
    expect(main.setSession).toHaveBeenCalledWith(S2);
  });

  it('TC-B1-86：交接失败 → 丢掉 S2（signOut local）、主客户端不换，回 rebind_failed', async () => {
    const { r, main, eph } = make({ account: () => new Response('{"error":"rebind_failed"}', { status: 409 }) });
    expect(await r.verifyAndRebind('a@b.c', '123456', 'dev-1')).toEqual({ ok: false, error: 'rebind_failed' });
    expect(eph.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(main.setSession).not.toHaveBeenCalled();
  });

  it('次数太多：rate_limited；断网：offline；两种都丢掉 S2', async () => {
    const a = make({ account: () => new Response('{"error":"rate_limited"}', { status: 429 }) });
    expect(await a.r.verifyAndRebind('a@b.c', '123456', 'dev-1')).toEqual({ ok: false, error: 'rate_limited' });
    expect(a.eph.signOut).toHaveBeenCalled();
    const b = make({ account: () => Promise.reject(new TypeError('net')) });
    expect(await b.r.verifyAndRebind('a@b.c', '123456', 'dev-1')).toEqual({ ok: false, error: 'offline' });
    expect(b.main.setSession).not.toHaveBeenCalled();
  });

  it('验证码不对：不调 account，不换会话', async () => {
    const { r, fetch, main } = make({ verify: vi.fn(async () => ({ data: { session: null }, error: { status: 403, name: 'AuthApiError' } })) });
    expect(await r.verifyAndRebind('a@b.c', '000000', 'dev-1')).toEqual({ ok: false, error: 'otp_invalid' });
    expect(fetch).not.toHaveBeenCalled();
    expect(main.setSession).not.toHaveBeenCalled();
  });

  it('旧会话刷不出来：signed_out，不验码', async () => {
    const { r, eph } = make({ refreshError: { status: 400, name: 'AuthApiError' } });
    expect(await r.verifyAndRebind('a@b.c', '123456', 'dev-1')).toEqual({ ok: false, error: 'signed_out' });
    expect(eph.verifyOtp).not.toHaveBeenCalled();
  });

  it('本机还没有设备行：跳过交接，直接换上 S2', async () => {
    const { r, fetch, main } = make();
    expect(await r.verifyAndRebind('a@b.c', '123456', null)).toEqual({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(main.setSession).toHaveBeenCalledWith(S2);
  });
});

describe('rebindErrOf', () => {
  it('账号码、入口码、状态', () => {
    expect(rebindErrOf(409, 'rebind_failed')).toBe('rebind_failed');
    expect(rebindErrOf(401, 'reauth_required')).toBe('reauth_required');
    expect(rebindErrOf(401, 'session_revoked')).toBe('session_revoked');
    expect(rebindErrOf(400, 'bad_request')).toBe('unknown');
    expect(rebindErrOf(503, null)).toBe('try_later');
    expect(rebindErrOf(429, null)).toBe('rate_limited');
    expect(rebindErrOf(418, 'confirm_required')).toBe('unknown');
  });
});
