// 登录接口（架构 5.6、15.2 中 1）：发码带 Turnstile 令牌、不建新用户；错误码归类；邀请注册两步
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import {
  createAuthApi,
  isEmail,
  isInviteFormat,
  mapAuthError,
  normalizeInvite,
  normalizeOtp,
  retryAfterSeconds,
  splitCodeError,
  OTP_TTL_MS,
  RATE_LIMIT_MSG,
  sessionIdOfToken,
} from '../data/auth-api.ts';

function fakeDb(over: {
  signInWithOtp?: unknown;
  verifyOtp?: unknown;
  invoke?: unknown;
  getSession?: unknown;
  signOut?: unknown;
}, readToken: () => string | null = () => null) {
  const auth = {
    getSession: vi.fn(async () => over.getSession ?? { data: { session: null }, error: null }),
    signOut: vi.fn(async () => over.signOut ?? { error: null }),
    signInWithOtp: vi.fn(async () => over.signInWithOtp ?? { data: {}, error: null }),
    verifyOtp: vi.fn(async () => over.verifyOtp ?? { data: { session: { access_token: 'x' } }, error: null }),
  };
  const functions = { invoke: vi.fn(async () => over.invoke ?? { data: { ok: true }, error: null }) };
  const devices = { eq: vi.fn(async (_c: string, _v: string): Promise<unknown> => ({ error: null })) };
  const from = vi.fn(() => ({ delete: () => devices }));
  const db = { auth, functions, from } as unknown as Db;
  return { db, auth, functions, from, devices, api: createAuthApi(async () => db, readToken) };
}

/** 只有 payload 有意义的假 JWT（测试用，不是令牌） */
function tokenWith(payload: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
  return `x.${b64}.y`;
}

describe('mapAuthError', () => {
  it('GoTrue 的错误码归到界面的几种', () => {
    expect(mapAuthError({ code: 'otp_disabled', status: 422, message: 'Signups not allowed for otp' })).toBe('not_registered');
    expect(mapAuthError({ message: 'Signups not allowed for otp' })).toBe('not_registered');
    expect(mapAuthError({ code: 'over_email_send_rate_limit', status: 429, message: 'For security purposes, you can only request this after 47 seconds.' })).toBe('rate_limited');
    expect(mapAuthError({ code: 'over_email_send_rate_limit', status: 429, message: 'email rate limit exceeded' })).toBe('send_quota');
    expect(mapAuthError({ code: 'over_request_rate_limit', status: 429 })).toBe('send_quota');
    expect(mapAuthError({ status: 429 })).toBe('send_quota');
    expect(mapAuthError({ code: 'captcha_failed', status: 400 })).toBe('captcha_failed');
    expect(mapAuthError({ code: 'otp_expired', status: 403 })).toBe('code_invalid');
    expect(mapAuthError({ name: 'AuthRetryableFetchError', status: 0 })).toBe('offline');
    expect(mapAuthError({ code: 'something_new' })).toBe('unknown');
    expect(mapAuthError('boom')).toBe('unknown');
  });

  it('“填错”和“过期”按发码时间分（GoTrue 两种都回 otp_expired）', () => {
    expect(splitCodeError('code_invalid', 0, OTP_TTL_MS - 1)).toBe('code_wrong');
    expect(splitCodeError('code_invalid', 0, OTP_TTL_MS)).toBe('code_expired');
    expect(splitCodeError('offline', 0, OTP_TTL_MS)).toBe('offline');
  });
});

describe('createAuthApi', () => {
  it('发码：shouldCreateUser 为 false、带 captchaToken（不给 Supabase 建新用户的机会，R-83）', async () => {
    const { api, auth } = fakeDb({});
    expect(await api.sendCode('a@b.co', 'tok')).toEqual({ ok: true, value: undefined });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: 'a@b.co', options: { shouldCreateUser: false, captchaToken: 'tok' } });
  });

  it('发码：新邮箱回 not_registered（R-108）；同一邮箱 60 秒内再发回 rate_limited；全站额度用完回 send_quota（安全审查必改 2）', async () => {
    const a = fakeDb({ signInWithOtp: { data: {}, error: { code: 'otp_disabled', status: 422, message: 'Signups not allowed for otp' } } });
    expect(await a.api.sendCode('new@b.co', 't')).toEqual({ ok: false, error: 'not_registered' });
    const b = fakeDb({
      signInWithOtp: { data: {}, error: { code: 'over_email_send_rate_limit', status: 429, message: 'For security purposes, you can only request this after 60 seconds.' } },
    });
    expect(await b.api.sendCode('a@b.co', 't')).toEqual({ ok: false, error: 'rate_limited', waitS: 60 });
    const c = fakeDb({ signInWithOtp: { data: {}, error: { code: 'over_email_send_rate_limit', status: 429, message: 'email rate limit exceeded' } } });
    expect(await c.api.sendCode('a@b.co', 't')).toEqual({ ok: false, error: 'send_quota' });
  });

  it('单个邮箱限频：带上原文里的 N 秒（K4 复审低 3）；取不到不带', async () => {
    const a = fakeDb({ signInWithOtp: { data: {}, error: { code: 'over_email_send_rate_limit', status: 429, message: 'For security purposes, you can only request this after 47 seconds.' } } });
    expect(await a.api.sendCode('a@b.co', 't')).toEqual({ ok: false, error: 'rate_limited', waitS: 47 });
    expect(retryAfterSeconds({ message: 'you can only request this after 1 second' })).toBe(1);
    expect(retryAfterSeconds({ message: 'you can only request this after 0 seconds' })).toBeUndefined();
    expect(retryAfterSeconds({ message: 'you can only request this after 99999 seconds' })).toBeUndefined();
    expect(retryAfterSeconds({ message: 'email rate limit exceeded' })).toBeUndefined();
    expect(retryAfterSeconds(null)).toBeUndefined();
  });

  it('login-probe.mjs 检查真 GoTrue 原文用的正则和前端一致（K4 复审低 2）', () => {
    const probe = readFileSync(join(import.meta.dirname, '../../../../supabase/tests/auth/login-probe.mjs'), 'utf8');
    expect(probe).toContain(`/${RATE_LIMIT_MSG.source}/${RATE_LIMIT_MSG.flags}`);
  });

  it('校验：type email；拿到会话算成功；客户端拿不到（getDb 抛错）算 unknown', async () => {
    const { api, auth } = fakeDb({});
    expect(await api.verifyCode('a@b.co', '123456')).toEqual({ ok: true, value: undefined });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: 'a@b.co', token: '123456', type: 'email' });
    const broken = createAuthApi(async () => {
      throw new Error('supabase_env_missing');
    });
    expect(await broken.verifyCode('a@b.co', '123456')).toEqual({ ok: false, error: 'unknown' });
  });

  it('邀请 start：调 invite-signup，带 Turnstile 令牌和语言', async () => {
    const { api, functions } = fakeDb({});
    const r = await api.inviteStart({ email: 'n@b.co', code: 'ABCDEFGHJKLM', captchaToken: 'tok', locale: 'ko-KR' });
    expect(r.ok).toBe(true);
    expect(functions.invoke).toHaveBeenCalledWith('invite-signup', {
      body: { step: 'start', email: 'n@b.co', code: 'ABCDEFGHJKLM', captchaToken: 'tok', locale: 'ko-KR' },
    });
  });

  it('邀请 verify：拿 token_hash 换会话（type magiclink）', async () => {
    const { api, functions, auth } = fakeDb({ invoke: { data: { token_hash: 'th' }, error: null } });
    expect(await api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '654321', locale: 'ko-KR' })).toEqual({ ok: true, value: undefined });
    // 架构 0.38 第 20 条：verify 也带 locale（界面语言）
    expect(functions.invoke).toHaveBeenCalledWith('invite-signup', {
      body: { step: 'verify', email: 'n@b.co', code: 'ABCDEFGHJKLM', email_otp: '654321', locale: 'ko-KR' },
    });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'th', type: 'magiclink' });
  });

  it('邀请 verify：函数回的错误码按响应体分（架构 5.6、0.38 第 20 条的口径）', async () => {
    for (const [code, status, want] of [
      ['invite_invalid', 400, 'invite_invalid'],
      ['email_exists', 409, 'email_exists'],
      ['code_wrong', 400, 'code_wrong'],
      ['code_expired', 410, 'code_expired'],
      ['too_many_tries', 400, 'too_many_tries'],
      ['link_failed', 502, 'registered_login'],
      ['try_later', 503, 'try_later'],
      ['rate_limited', 429, 'verify_limited'],
      ['bad_request', 400, 'unknown'],
      ['misconfigured', 500, 'unknown'],
      ['something_new', 400, 'unknown'],
    ] as const) {
      const ctx = new Response(JSON.stringify({ error: code }), { status });
      const { api, auth } = fakeDb({ invoke: { data: null, error: { name: 'FunctionsHttpError', context: ctx } } });
      expect(await api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '1', locale: 'zh-CN' })).toEqual({ ok: false, error: want });
      expect(auth.verifyOtp).not.toHaveBeenCalled();
    }
  });

  it('错误体按 apiError {error: 码} 读（0.38 第 54 条）：老写法 {code}、null、非字符串都不认；多带的字段不影响', async () => {
    for (const [body, want] of [
      [{ error: 'code_wrong', purge_after: '2026-11-28T00:00:00Z' }, 'code_wrong'],
      [{ code: 'code_wrong' }, 'unknown'],
      [null, 'unknown'],
      [{ error: 42 }, 'unknown'],
    ] as const) {
      const ctx = new Response(JSON.stringify(body), { status: 400 });
      const { api } = fakeDb({ invoke: { data: null, error: { name: 'FunctionsHttpError', context: ctx } } });
      expect(await api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '1', locale: 'zh-CN' })).toEqual({ ok: false, error: want });
    }
  });

  it('邀请 verify：账号建好了但 token_hash 换不到会话 → registered_login（安全审查低 4）', async () => {
    const a = fakeDb({ invoke: { data: { token_hash: 'th' }, error: null }, verifyOtp: { data: { session: null }, error: { code: 'otp_expired' } } });
    expect(await a.api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '1', locale: 'zh-CN' })).toEqual({ ok: false, error: 'registered_login' });
    const b = fakeDb({ invoke: { data: { token_hash: 'th' }, error: null } });
    b.auth.verifyOtp.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await b.api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '1', locale: 'zh-CN' })).toEqual({ ok: false, error: 'registered_login' });
  });

  it('邀请 start：只认 captcha_failed、try_later（0.38 第 27 条）；万一回 429 也不出“太频繁”，按 try_later', async () => {
    for (const [body, status, want] of [
      ['{"error":"captcha_failed"}', 403, 'captcha_failed'],
      ['{"error":"try_later"}', 503, 'try_later'],
      ['{}', 429, 'try_later'],
      ['{"error":"rate_limited"}', 429, 'try_later'],
    ] as const) {
      const ctx = new Response(body, { status });
      const { api } = fakeDb({ invoke: { data: null, error: { name: 'FunctionsHttpError', context: ctx } } });
      expect(await api.inviteStart({ email: 'n@b.co', code: 'ABCDEFGHJKLM', captchaToken: 't', locale: 'zh-CN' })).toEqual({ ok: false, error: want });
    }
  });

  it('邀请 verify 回 429（不管响应体）：verify_limited，不说“60 秒后再发”', async () => {
    const ctx = new Response('{}', { status: 429 });
    const { api } = fakeDb({ invoke: { data: null, error: { name: 'FunctionsHttpError', context: ctx } } });
    expect(await api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '1', locale: 'zh-CN' })).toEqual({ ok: false, error: 'verify_limited' });
  });

  it('退出并换账号（4.1、0.38 第 35 条）：不调 getSession；按本机令牌里的 session_id 删那一行 devices，再 signOut local', async () => {
    const order: string[] = [];
    const a = fakeDb({}, () => tokenWith({ session_id: 'sess-1' }));
    a.devices.eq.mockImplementation(async () => {
      order.push('devices');
      return { error: null };
    });
    a.auth.signOut.mockImplementation(async () => {
      order.push('signOut');
      return { error: null };
    });
    expect(await a.api.signOutHere()).toEqual({ ok: true, value: undefined });
    expect(a.from).toHaveBeenCalledWith('devices');
    expect(a.devices.eq).toHaveBeenCalledWith('session_id', 'sess-1');
    expect(a.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(a.auth.getSession).not.toHaveBeenCalled();
    expect(order).toEqual(['devices', 'signOut']);
  });

  it('退出并换账号：本机没令牌不删行、照样 signOut；删行出错不挡 signOut', async () => {
    const none = fakeDb({}, () => null);
    expect(await none.api.signOutHere()).toEqual({ ok: true, value: undefined });
    expect(none.from).not.toHaveBeenCalled();
    expect(none.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });

    const broken = fakeDb({}, () => tokenWith({ session_id: 's' }));
    broken.devices.eq.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await broken.api.signOutHere()).toEqual({ ok: true, value: undefined });
    expect(broken.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('退出并换账号：不是 ok 的一律回错（断网、令牌过期、客户端拿不到），调用方据此兜底清本机会话', async () => {
    const offline = fakeDb({ signOut: { error: { name: 'AuthRetryableFetchError', status: 0 } } }, () => null);
    expect(await offline.api.signOutHere()).toEqual({ ok: false, error: 'offline' });
    const expired = fakeDb({ signOut: { error: { code: 'session_expired', status: 403 } } }, () => null);
    expect((await expired.api.signOutHere()).ok).toBe(false);
    const noClient = createAuthApi(async () => {
      throw new Error('supabase_env_missing');
    }, () => null);
    expect((await noClient.signOutHere()).ok).toBe(false);
  });

  it('sessionIdOfToken：只读 payload 的 session_id；格式不对回 null', () => {
    expect(sessionIdOfToken(tokenWith({ session_id: 'abc' }))).toBe('abc');
    expect(sessionIdOfToken(tokenWith({}))).toBeNull();
    expect(sessionIdOfToken('not-a-jwt')).toBeNull();
    expect(sessionIdOfToken('a.%%%.c')).toBeNull();
    expect(sessionIdOfToken(null)).toBeNull();
  });

  it('邀请 verify：没回 token_hash 不算成功', async () => {
    const { api } = fakeDb({ invoke: { data: {}, error: null } });
    expect(await api.inviteVerify({ email: 'n@b.co', code: 'ABCDEFGHJKLM', emailOtp: '1', locale: 'zh-CN' })).toEqual({ ok: false, error: 'unknown' });
  });
});

describe('输入整理', () => {
  it('邮箱、邀请码、验证码', () => {
    expect(isEmail(' a@b.co ')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(normalizeInvite('abcd-efgh jklm')).toBe('ABCDEFGHJKLM');
    expect(isInviteFormat('abcd-efgh-jklm')).toBe(true);
    expect(isInviteFormat('ABCDEFGHJKL')).toBe(false);
    expect(isInviteFormat('ABCDEFGHJKL!')).toBe(false);
    expect(normalizeOtp('12 34-567')).toBe('123456');
  });
});
