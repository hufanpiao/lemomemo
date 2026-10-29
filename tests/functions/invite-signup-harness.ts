// tests/functions/invite-signup*.test.ts 共用（B1 第九批从 invite-signup.test.ts 拆出）：常量、假 invites / pending_signups / counters、假 Auth、
// world()、造请求和调用 handle 的小工具。假库的比较并交换和真 UPDATE … WHERE 同一个语义，take_rate 和迁移同一个口径（先计数再判断）。
import { vi } from 'vitest';
import {
  handle, type AuthAdmin, type Deps, type InviteRow, type PendingRow, type Store, type TurnstileResult,
} from '../../supabase/functions/invite-signup/core.ts';
import { inviteCodeHash } from '../../supabase/functions/_shared/invite-code.ts';

export const NOW = Date.parse('2026-10-29T12:00:00Z');
export const SECRET = 'test-hash-secret';
export const PROXY = 'test-proxy-secret';
export const CODE = 'ABCD2345EFGH';          // 有效码
export const CODE2 = 'WXYZ6789KLMN';         // 另一个
export const OTP = 123456;
export const USER = 'cccccccc-0000-4000-8000-0000000000ad';   // 发码的管理员（邀请人）；和假 Auth 建出来的新用户 id 不同
// 0001 的 counters 键约束（附录 A：每个写键处一条单元测试断言生成的键过得了它）
export const COUNTER_KEY = /^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$/;

export class FakeStore implements Store {
  invites = new Map<string, InviteRow>();
  pending = new Map<string, PendingRow>();
  counters = new Map<string, number>();
  profiles: { userId: string; locale: string }[] = [];
  minVersion: string | null = null;
  failProfile = false;
  private async tick() { await Promise.resolve(); }   // 让并发的两个请求真的交错

  async takeRate(key: string, limit: number) {
    if (!COUNTER_KEY.test(key)) throw new Error('23514 counters_key_check');
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n <= limit;
  }
  async getInvite(h: string) { await this.tick(); const r = this.invites.get(h); return r ? { ...r } : null; }
  async casInviteUsed(h: string, from: number, to: number, notExpiredAt: string | null) {
    await this.tick();
    const r = this.invites.get(h);
    if (!r || r.used_count !== from) return false;
    if (notExpiredAt && !(r.expires_at && Date.parse(r.expires_at) > Date.parse(notExpiredAt))) return false;
    r.used_count = to;
    return true;
  }
  async putPending(eh: string, row: PendingRow) { this.pending.set(eh, { ...row }); }
  async getPending(eh: string) { await this.tick(); const r = this.pending.get(eh); return r ? { ...r } : null; }
  async casPendingTries(eh: string, from: number, to: number, otpHash: string) {
    await this.tick();
    const r = this.pending.get(eh);
    if (!r || r.tries !== from || r.otp_hash !== otpHash) return false;
    r.tries = to;
    return true;
  }
  /** 删之前的钩子：测试用它模拟“读到行之后、删除之前用户重新拿了新码” */
  beforeDelete: (() => void) | null = null;
  async deletePending(eh: string, otpHash?: string) {
    this.beforeDelete?.();
    if (otpHash !== undefined && this.pending.get(eh)?.otp_hash !== otpHash) return;
    this.pending.delete(eh);
  }
  async insertProfile(userId: string, locale: 'zh-CN' | 'ko-KR') {
    if (this.failProfile) throw new Error('db');
    this.profiles.push({ userId, locale });
  }
  async minClientVersion() { return this.minVersion; }
}

export class FakeAuth implements AuthAdmin {
  users = new Map<string, string>();   // email → id
  failCreate = false;
  failLink = false;
  created: { email: string; locale: string; args: number }[] = [];
  deleted: string[] = [];
  n = 0;
  async createUser(email: string, locale: 'zh-CN' | 'ko-KR', ...rest: unknown[]) {
    this.created.push({ email, locale, args: 2 + rest.length });
    if (this.failCreate) return { ok: false as const, exists: false };
    if (this.users.has(email)) return { ok: false as const, exists: true };
    const id = `aaaaaaaa-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    this.users.set(email, id);
    return { ok: true as const, userId: id };
  }
  failDelete = false;
  async deleteUser(id: string) {
    if (this.failDelete) throw new Error('auth');
    this.deleted.push(id);
    for (const [e, v] of this.users) if (v === id) this.users.delete(e);
  }
  async magiclinkTokenHash(email: string) { return this.failLink || !this.users.has(email) ? null : `th-${this.users.get(email)}`; }
}

export interface World { store: FakeStore; auth: FakeAuth; mails: { to: string; subject: string; text: string }[]; logs: string[]; deps: Deps; turnstile: ReturnType<typeof vi.fn> }

export async function world(over: Partial<Deps> = {}): Promise<World> {
  const store = new FakeStore();
  const auth = new FakeAuth();
  const mails: World['mails'] = [];
  const logs: string[] = [];
  const turnstile = vi.fn(async (token: string, _ip: string | null): Promise<TurnstileResult> =>
    token === 'ok-token' ? { success: true, hostname: 'lemomemo.com', action: 'invite_start' } : { success: false, hostname: null, action: null });
  for (const [c, max] of [[CODE, 1], [CODE2, 3]] as const) {
    store.invites.set(await inviteCodeHash(c), { max_uses: max, used_count: 0, expires_at: new Date(NOW + 7 * 86400_000).toISOString() });
  }
  const deps: Deps = {
    store, auth,
    env: 'prod',
    verifyTurnstile: turnstile,
    sendMail: async (to, m) => { mails.push({ to, ...m }); return true; },
    hashSecret: SECRET, proxySecret: PROXY, configured: true,
    now: () => NOW, randomOtp: () => OTP,
    log: (c) => logs.push(c),
    ...over,
  };
  return { store, auth, mails, logs, deps, turnstile };
}

export function req(body: unknown, headers: Record<string, string> = {}, method = 'POST'): Request {
  const h = new Headers({ 'content-type': 'application/json', ...headers });
  return new Request('https://x.supabase.co/functions/v1/invite-signup', method === 'GET' ? { method, headers: h } : { method, headers: h, body: JSON.stringify(body) });
}
export const viaProxy = (ip: string) => ({ 'x-proxy-secret': PROXY, 'x-client-ip': ip });
export const startBody = (email: string, code = CODE, extra: Record<string, unknown> = {}) => ({ step: 'start', email, code, captchaToken: 'ok-token', locale: 'zh-CN', ...extra });
export const verifyBody = (email: string, otp = String(OTP), code = CODE, extra: Record<string, unknown> = {}) => ({ step: 'verify', email, code, email_otp: otp, ...extra });
export async function call(w: World, body: unknown, headers: Record<string, string> = viaProxy('203.0.113.7')) {
  const r = await handle(req(body, headers), w.deps);
  return { status: r.status, text: await r.text() };
}
