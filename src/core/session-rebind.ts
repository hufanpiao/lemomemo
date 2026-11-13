// 重新验证邮箱后交接设备行（B5 S3；架构 0.29 续第 104、112、119 条；代定 D5：模块叫 session-rebind.ts，不动 features/auth/data/reauth.ts）
// 顺序：
//   ① 主客户端 refreshSession() 拿旧会话 S1 的 access token（只在内存）
//   ② 一次性客户端（不保存会话，platform/supabase/ephemeral.ts）verifyOtp 拿新会话 S2
//   ③ 带 S2 调 account {action: 'rebind_device', device_id, old_token: S1}
//   ④ 成功：主客户端 setSession(S2)（S1 已被服务器吊销）；**明确失败**（服务器回了 4xx：409 rebind_failed、429 rate_limited、
//      401 reauth_required 等，都在 rpc 之前或 rpc 拒绝，S1 没动）：一次性客户端 signOut({scope: 'local'}) 丢掉 S2，主客户端照旧用 S1，
//      界面提示重试（TC-B1-86）。rate_limited → “今天重新验证的次数太多，请明天再试”
//   • **结果不确定**（没拿到响应、5xx；11-14 独立评审 M5）：服务器可能已经吊销了 S1，丢掉 S2 就等于把用户退出登录。所以 S2 留着（只在内存），
//     当场再发两次交接（服务器对“这台设备行已经挂在 S2 上”回成功，可重入，tests/functions/account-rebind.test.ts）；还不确定就回 offline / try_later，
//     S2 继续留着，用户再点一次“验证”时不再验码、直接重发交接。setSession(S2) 失败同样留着 S2 下次再试
// • 本机还没有设备行（deviceId 为 null，比如刚登录、登记还没成功）：没有可交接的行，跳过 ③ 直接 setSession(S2)，
//   之后 device-reg 照常为 S2 登记（交回里记了这条代定）
// • old_token 不写日志、不落存储；请求失败只回码
// • S2 留着的这段时间（11-14 整块评审第 5 条）：在 core/rebind-pending.ts 登记 finish——别处收到 session_revoked 要退出时先把交接做完，
//   换上 S2 就不退出、不清库。运行日志只记交接结果（ok / refused 码 / unsure 码），不记令牌、邮箱、验证码
// 纯 TS：不准 import React（A1）；联网经注入的 fetch（A12）
import { accountErrorCode } from '../../shared/schema/account.ts';
import { isEntryErrorCode } from '../../shared/schema/entry-codes.ts';
import { rlog } from '../platform/run-log-api.ts';
import { setRebindRescue } from './rebind-pending.ts';

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

/** 已经拿到 S2、还没换上的这一次（结果不确定时留到下一次） */
interface Pending {
  main: MainAuth;
  auth: EphemeralAuth;
  s1: string;
  s2: SessionPair;
  deviceId: string | null;
}

/** 一次交接请求的结果：ok、服务器明确拒了（带码）、不确定（没拿到响应或 5xx） */
type HandOver = { kind: 'ok' } | { kind: 'refused'; error: RebindErr } | { kind: 'unsure'; error: 'offline' | 'try_later' };

/** 结果不确定时当场再发几次（服务器可重入） */
export const REBIND_RETRIES = 2;

export function createSessionRebind(d: RebindDeps) {
  let eph: Promise<EphemeralAuth> | null = null;
  const ephemeral = (): Promise<EphemeralAuth> => (eph ??= d.ephemeral());
  let pending: Pending | null = null;

  async function handOver(p: Pending, deviceId: string): Promise<HandOver> {
    try {
      const res = await d.fetch(d.accountUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.s2.access_token}`, apikey: d.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rebind_device', device_id: deviceId, old_token: p.s1 }),
        cache: 'no-store',
      });
      if (res.ok) return { kind: 'ok' };
      if (res.status >= 500) return { kind: 'unsure', error: 'try_later' };
      let c: unknown = null;
      try {
        c = ((await res.json()) as { error?: unknown } | null)?.error ?? null;
      } catch {
        c = null;
      }
      return { kind: 'refused', error: rebindErrOf(res.status, c) };
    } catch {
      return { kind: 'unsure', error: 'offline' };
    }
  }

  /** 丢掉 S2（明确失败时）：主客户端照旧用 S1 */
  async function drop(p: Pending, error: RebindErr): Promise<RebindResult> {
    keep(null);
    try {
      await p.auth.signOut({ scope: 'local' });
    } catch {
      // 内存里的 S2 没了就行
    }
    return { ok: false, error };
  }

  /** 记下（或清掉）还没换上的 S2，同时在退出闸登记 / 撤销 */
  function keep(p: Pending | null): void {
    pending = p;
    setRebindRescue(p ? async () => (pending ? (await finish(pending)).ok : false) : null);
  }

  /** ③④：交接（不确定就当场重发）→ 换上 S2 */
  async function finish(p: Pending): Promise<RebindResult> {
    if (p.deviceId) {
      let r = await handOver(p, p.deviceId);
      for (let i = 0; i < REBIND_RETRIES && r.kind === 'unsure'; i++) r = await handOver(p, p.deviceId);
      rlog(`rebind ${r.kind}${r.kind === 'ok' ? '' : ` ${r.error}`}`);
      if (r.kind === 'refused') return drop(p, r.error);
      if (r.kind === 'unsure') return { ok: false, error: r.error };   // S2 留着，下次直接重发
    }
    try {
      const { error } = await p.main.setSession({ access_token: p.s2.access_token, refresh_token: p.s2.refresh_token });
      if (error) {
        rlog('rebind set_session failed');
        return { ok: false, error: 'try_later' };
      }
    } catch {
      rlog('rebind set_session failed');
      return { ok: false, error: 'try_later' };
    }
    keep(null);
    return { ok: true };
  }

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

    /** 验证码 → S2 → 交接 → 换上 S2；上次结果不确定、S2 还留着时不再验码，直接重发交接 */
    async verifyAndRebind(email: string, code: string, deviceId: string | null): Promise<RebindResult> {
      if (pending) return finish(pending);
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
      const p: Pending = { main, auth, s1, s2, deviceId };
      keep(p);
      return finish(p);
    },
  };
}
