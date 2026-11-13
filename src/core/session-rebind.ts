// 重新验证邮箱后交接设备行（B5 S3；架构 0.29 续第 104、112、119 条；代定 D5：模块叫 session-rebind.ts，不动 features/auth/data/reauth.ts）
// 顺序：
//   ① 主客户端 refreshSession() 拿旧会话 S1 的 access token（只在内存）
//   ② 一次性客户端（不保存会话，platform/supabase/ephemeral.ts）verifyOtp 拿新会话 S2
//   ③ 带 S2 调 account {action: 'rebind_device', device_id, old_token: S1}
//   ④ 成功：主客户端 setSession(S2)（S1 已被服务器吊销）；失败：一次性客户端 signOut({scope: 'local'}) 丢掉 S2，主客户端照旧用 S1，
//      界面提示重试（TC-B1-86）。rate_limited → “今天重新验证的次数太多，请明天再试”
// • 本机还没有设备行（deviceId 为 null，比如刚登录、登记还没成功）：没有可交接的行，跳过 ③ 直接 setSession(S2)，
//   之后 device-reg 照常为 S2 登记（交回里记了这条代定）
// • old_token 不写日志、不落存储；请求失败只回码
// 纯 TS：不准 import React（A1）；联网经注入的 fetch（A12）
import { accountErrorCode } from '../../shared/schema/account.ts';
import { isEntryErrorCode } from '../../shared/schema/entry-codes.ts';

export type RebindErr = 'otp_invalid' | 'rebind_failed' | 'rate_limited' | 'reauth_required' | 'try_later' | 'offline' | 'signed_out' | 'session_revoked' | 'unknown';
export type RebindResult = { ok: true } | { ok: false; error: RebindErr };

interface SessionPair {
  access_token: string;
  refresh_token: string;
}

/** 主客户端要用到的几个方法（supabase-js auth 的子集，测试好替） */
export interface MainAuth {
  refreshSession(): Promise<{ data: { session: SessionPair | null }; error: unknown }>;
  setSession(s: SessionPair): Promise<{ error: unknown }>;
}

export interface EphemeralAuth {
  signInWithOtp(a: { email: string; options: { shouldCreateUser: false } }): Promise<{ error: unknown }>;
  verifyOtp(a: { email: string; token: string; type: 'email' }): Promise<{ data: { session: SessionPair | null }; error: unknown }>;
  signOut(a: { scope: 'local' }): Promise<{ error: unknown }>;
}

export interface RebindDeps {
  main(): Promise<MainAuth>;
  ephemeral(): Promise<EphemeralAuth>;
  /** 调 account：POST JSON，自己带 apikey */
  fetch(url: string, init: RequestInit): Promise<Response>;
  accountUrl: string;
  anonKey: string;
}

function otpErr(e: unknown): RebindErr {
  const status = (e as { status?: unknown } | null)?.status;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'AuthRetryableFetchError' || name === 'TypeError') return 'offline';
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 500) return 'try_later';
  return 'otp_invalid';
}

/** account 的失败 → 码（导出给测试） */
export function rebindErrOf(status: number, code: unknown): RebindErr {
  if (isEntryErrorCode(code)) return code === 'session_revoked' || code === 'unauthorized' ? 'session_revoked' : 'unknown';
  const c = accountErrorCode.safeParse(code);
  if (c.success) {
    switch (c.data) {
      case 'rebind_failed':
      case 'rate_limited':
      case 'reauth_required':
      case 'try_later':
        return c.data;
      default:
        return 'unknown';
    }
  }
  if (status >= 500) return 'try_later';
  if (status === 429) return 'rate_limited';
  return 'unknown';
}

export function createSessionRebind(d: RebindDeps) {
  let eph: Promise<EphemeralAuth> | null = null;
  const ephemeral = (): Promise<EphemeralAuth> => (eph ??= d.ephemeral());

  return {
    /** 发邮箱验证码（不建新用户） */
    async sendCode(email: string): Promise<RebindResult> {
      try {
        const { error } = await (await ephemeral()).signInWithOtp({ email, options: { shouldCreateUser: false } });
        if (!error) return { ok: true };
        const e = otpErr(error);
        return { ok: false, error: e === 'otp_invalid' ? 'unknown' : e };
      } catch {
        return { ok: false, error: 'offline' };
      }
    },

    /** 验证码 → S2 → 交接 → 换上 S2 */
    async verifyAndRebind(email: string, code: string, deviceId: string | null): Promise<RebindResult> {
      let main: MainAuth;
      let s1: string;
      try {
        main = await d.main();
        const r = await main.refreshSession();
        if (r.error || !r.data.session) return { ok: false, error: otpErr(r.error) === 'offline' ? 'offline' : 'signed_out' };
        s1 = r.data.session.access_token;
      } catch {
        return { ok: false, error: 'offline' };
      }
      let auth: EphemeralAuth;
      let s2: SessionPair;
      try {
        auth = await ephemeral();
        const v = await auth.verifyOtp({ email, token: code, type: 'email' });
        if (v.error || !v.data.session) return { ok: false, error: v.error ? otpErr(v.error) : 'otp_invalid' };
        s2 = v.data.session;
      } catch {
        return { ok: false, error: 'offline' };
      }
      const drop = async (error: RebindErr): Promise<RebindResult> => {
        try {
          await auth.signOut({ scope: 'local' });
        } catch {
          // 内存里的 S2 没了就行
        }
        return { ok: false, error };
      };
      if (deviceId) {
        try {
          const res = await d.fetch(d.accountUrl, {
            method: 'POST',
            headers: { authorization: `Bearer ${s2.access_token}`, apikey: d.anonKey, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'rebind_device', device_id: deviceId, old_token: s1 }),
            cache: 'no-store',
          });
          if (!res.ok) {
            let c: unknown = null;
            try {
              c = ((await res.json()) as { error?: unknown } | null)?.error ?? null;
            } catch {
              c = null;
            }
            return drop(rebindErrOf(res.status, c));
          }
        } catch {
          return drop('offline');
        }
      }
      try {
        const { error } = await main.setSession({ access_token: s2.access_token, refresh_token: s2.refresh_token });
        if (error) return drop('unknown');
      } catch {
        return drop('unknown');
      }
      return { ok: true };
    },
  };
}
