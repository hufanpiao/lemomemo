// tests/functions/invite-signup*.test.ts 共用（B1 第九批从 invite-signup.test.ts 拆出）：常量、假 invites / pending_signups / counters、假 Auth、
// world()、造请求和调用 handle 的小工具。假库的比较并交换和真 UPDATE … WHERE 同一个语义，占码、退码照迁移 20261031150000 的两个函数，take_rate 和迁移同一个口径（先计数再判断）。
import { expect, vi } from 'vitest';
import {
  handle, type AuthAdmin, type Deps, type InviteRow, type PendingRow, type Store, type TurnstileResult,
} from '../../supabase/functions/invite-signup/core.ts';
import { inviteCodeHash } from '../../supabase/functions/_shared/invite-code.ts';
import { withAuthTimeouts, withStoreTimeouts } from '../../supabase/functions/invite-signup/store-timeout.ts';

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
  /** pending_signups.claimed_code（迁移 20261031150000）：邮箱哈希 → 已占的 code_hash；putPending 不碰它（和 upsert 不带这一列一样） */
  claimed = new Map<string, string>();
  /** 照 private.invite_claim：锁住这一版 pending，已占这个码回 reused；换了码先退旧码、回 reused；没占就原子 +1、记下、回 ok */
  async claimInvite(eh: string, otpHash: string, h: string, notExpiredAt: string) {
    await this.tick();
    const p = this.pending.get(eh);
    if (!p || p.otp_hash !== otpHash) return 'no_pending' as const;
    const c = this.claimed.get(eh);
    if (c === h) return 'reused' as const;
    const r = this.invites.get(h);
    if (!r || r.max_uses === null || r.used_count === null || r.expires_at === null) return 'invalid' as const;
    if (!(Date.parse(r.expires_at) > Date.parse(notExpiredAt)) || r.used_count >= r.max_uses) return 'invalid' as const;
    r.used_count += 1;
    if (c !== undefined) { const old = this.invites.get(c); if (old && old.used_count !== null && old.used_count > 0) old.used_count -= 1; }
    this.claimed.set(eh, h);
    return c === undefined ? 'ok' as const : 'reused' as const;
  }
  /** 照 private.invite_release：claimed_code 正是这个码才减一并清掉 */
  async releaseInvite(eh: string, h: string) {
    await this.tick();
    if (this.claimed.get(eh) !== h) return false;
    this.claimed.delete(eh);
    const r = this.invites.get(h);
    if (r && r.used_count !== null && r.used_count > 0) r.used_count -= 1;
    return true;
  }
  async putPending(eh: string, row: PendingRow) { const { claimed_code: _c, ...rest } = row; this.pending.set(eh, rest); }
  async getPending(eh: string): Promise<PendingRow | null> { await this.tick(); const r = this.pending.get(eh); return r ? { ...r, claimed_code: this.claimed.get(eh) ?? null } : null; }
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
    this.claimed.delete(eh);
  }
  async insertProfile(userId: string, locale: 'zh-CN' | 'ko-KR') {
    if (this.failProfile) throw new Error('db');
    if (this.profiles.some((x) => x.userId === userId)) return false;   // 已有就不动（upsert ignoreDuplicates），回 false
    this.profiles.push({ userId, locale });
    return true;
  }
  async minClientVersion() { return this.minVersion; }
}

export class FakeAuth implements AuthAdmin {
  users = new Map<string, string>();   // email → id
  failCreate = false;
  failLink = false;
  /** userExists 抛错 */
  failExists = false;
  created: { email: string; locale: string; args: number }[] = [];
  deleted: string[] = [];
  /** createUser 收到的 id（core 按验证码派生） */
  ids: string[] = [];
  async createUser(id: string, email: string, locale: 'zh-CN' | 'ko-KR', ...rest: unknown[]) {
    this.created.push({ email, locale, args: 3 + rest.length });
    this.ids.push(id);
    if (this.failCreate) return { ok: false as const, exists: false };
    if (this.users.has(email)) return { ok: false as const, exists: true };
    this.users.set(email, id);
    return { ok: true as const, userId: id };
  }
  async userExists(id: string) {
    if (this.failExists) throw new Error('auth');
    return [...this.users.values()].includes(id);
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

// ---------- invite-late-commit.test.ts 用：超时包装下的“卡住”桩（从那边挪来，免得超 300 行） ----------
const MS = 20;
export const TRY_LATER = { status: 503, text: JSON.stringify({ error: 'try_later' }) };
export const STORE_METHODS = ['takeRate', 'getInvite', 'claimInvite', 'releaseInvite', 'putPending', 'getPending', 'casPendingTries', 'deletePending', 'insertProfile', 'minClientVersion'];
export const AUTH_METHODS = ['createUser', 'userExists', 'deleteUser', 'magiclinkTokenHash'];

export type Mode = 'before' | 'after' | false;
export type Hang = (m: string) => Mode;

export function hanging<S>(base: S, names: readonly string[], hang: () => Hang): S {
  const b = base as object;
  return Object.fromEntries(names.map((m) => [m, async (...a: unknown[]) => {
    const f = Reflect.get(b, m) as (...x: unknown[]) => Promise<unknown>;
    const h = hang()(m);
    if (h === 'after') await Reflect.apply(f, base, a);
    if (h) return new Promise(() => {});
    return Reflect.apply(f, base, a);
  }])) as S;
}

/** world 的 store、auth 套超时；setHang 随时换卡哪一步（不卡就是 () => false） */
export async function setup() {
  const w = await world();
  let hang: Hang = () => false;
  const log = (c: string) => w.logs.push(c);
  w.deps.store = withStoreTimeouts(() => hanging<Store>(w.store, STORE_METHODS, () => hang), { ms: MS, log });
  w.deps.auth = withAuthTimeouts(hanging<AuthAdmin>(w.auth, AUTH_METHODS, () => hang), { ms: MS, log });
  return { w, setHang: (h: Hang) => { hang = h; } };
}

/** 不套超时先走一遍 start（发出验证码） */
export async function handleStart(w: World) {
  expect((await call(w, startBody('a@example.com'))).status).toBe(200);
}

export const used = async (w: World, code = CODE) => w.store.invites.get(await inviteCodeHash(code))?.used_count;
export const only = (name: string, mode: Mode): Hang => (m) => (m === name ? mode : false);
