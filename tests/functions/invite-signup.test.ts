// invite-signup 的单元测试（架构 5.6、第 6 节、15.2 中 1 ④、附录 A counters 键表）：TC-B1-02、03、04、05、64 的函数一半。
// 只测 core.ts（index.ts 只是把 supabase-js、Turnstile、Resend 接上），数据库和 Auth 由假对象代替；
// 假 invites、pending_signups 的比较并交换和真 UPDATE … WHERE 同一个语义，take_rate 和迁移同一个口径（先计数再判断）。
// take_rate 本身在 supabase/tests/rls/08_take_rate.test.sql。
import { describe, expect, it, vi } from 'vitest';
import {
  handle, keys, secureOtp, signupMail, utcDate,
  LIMIT_GLOBAL_PER_DAY, LIMIT_IP_PER_HOUR, LIMIT_MAIL_PER_HOUR, LIMIT_VERIFY_IP_PER_HOUR, OTP_MAX_TRIES, UNTRUSTED_IP_BUCKET,
  type AuthAdmin, type Deps, type InviteRow, type PendingRow, type Store, type TurnstileResult,
} from '../../supabase/functions/invite-signup/core.ts';
import { emailHash } from '../../supabase/functions/_shared/email-hash.ts';
import { INVITE_ALPHABET, inviteCodeHash, isInviteCode } from '../../supabase/functions/_shared/invite-code.ts';
import { envKind, PREVIEW_REF } from '../../supabase/functions/_shared/env-kind.ts';
import { parseGeo, parseIp, rateIp, readProxyHeaders } from '../../supabase/functions/_shared/proxy-headers.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const SECRET = 'test-hash-secret';
const PROXY = 'test-proxy-secret';
const CODE = 'ABCD2345EFGH';          // 有效码
const CODE2 = 'WXYZ6789KLMN';         // 另一个
const OTP = 123456;
const USER = 'cccccccc-0000-4000-8000-0000000000ad';   // 发码的管理员（邀请人）；和假 Auth 建出来的新用户 id 不同
// 0001 的 counters 键约束（附录 A：每个写键处一条单元测试断言生成的键过得了它）
const COUNTER_KEY = /^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$/;

class FakeStore implements Store {
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

class FakeAuth implements AuthAdmin {
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

interface World { store: FakeStore; auth: FakeAuth; mails: { to: string; subject: string; text: string }[]; logs: string[]; deps: Deps; turnstile: ReturnType<typeof vi.fn> }

async function world(over: Partial<Deps> = {}): Promise<World> {
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

function req(body: unknown, headers: Record<string, string> = {}, method = 'POST'): Request {
  const h = new Headers({ 'content-type': 'application/json', ...headers });
  return new Request('https://x.supabase.co/functions/v1/invite-signup', method === 'GET' ? { method, headers: h } : { method, headers: h, body: JSON.stringify(body) });
}
const viaProxy = (ip: string) => ({ 'x-proxy-secret': PROXY, 'x-client-ip': ip });
const startBody = (email: string, code = CODE, extra: Record<string, unknown> = {}) => ({ step: 'start', email, code, captchaToken: 'ok-token', locale: 'zh-CN', ...extra });
const verifyBody = (email: string, otp = String(OTP), code = CODE, extra: Record<string, unknown> = {}) => ({ step: 'verify', email, code, email_otp: otp, ...extra });
async function call(w: World, body: unknown, headers: Record<string, string> = viaProxy('203.0.113.7')) {
  const r = await handle(req(body, headers), w.deps);
  return { status: r.status, text: await r.text() };
}

describe('共享模块', () => {
  it('邀请码：字母表 32 个字符、不含 0 O 1 I；12 位', () => {
    expect(INVITE_ALPHABET).toHaveLength(32);
    expect(new Set(INVITE_ALPHABET).size).toBe(32);
    for (const c of '0O1I') expect(INVITE_ALPHABET).not.toContain(c);
    expect(isInviteCode(CODE)).toBe(true);
    expect(isInviteCode('ABCD2345EFG0')).toBe(false);
    expect(isInviteCode('ABCD2345EFG')).toBe(false);
  });

  it('哈希：库里只有哈希；邮箱大小写、首尾空白算同一个', async () => {
    const h = await emailHash(SECRET, ' A@Example.com ');
    expect(h).toBe(await emailHash(SECRET, 'a@example.com'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(await emailHash('other', 'a@example.com'));
    expect(await inviteCodeHash('abcd-2345-efgh')).toBe(await inviteCodeHash(CODE));
  });

  it('三种计数键都过得了 counters 的 check 约束（附录 A）', async () => {
    expect(keys.ip(UNTRUSTED_IP_BUCKET)).toMatch(COUNTER_KEY);
    expect(keys.ip(await emailHash(SECRET, 'x@y.z'))).toMatch(COUNTER_KEY);
    expect(keys.mail(await emailHash(SECRET, 'x@y.z'))).toMatch(COUNTER_KEY);
    expect(keys.global(NOW)).toBe('signup:global:20261029');
    expect(keys.global(NOW)).toMatch(COUNTER_KEY);
    expect(utcDate(Date.parse('2026-10-29T23:59:59Z'))).toBe('20261029');
  });

  it('代理头：secret 对才信 x-client-ip、x-lemo-geo；没配 PROXY_SECRET 一律不信', () => {
    const r = (h: Record<string, string>) => new Request('https://x/', { headers: h });
    expect(readProxyHeaders(r({ 'x-proxy-secret': PROXY, 'x-client-ip': '198.51.100.1', 'x-lemo-geo': 'KR|Seoul' }), PROXY))
      .toEqual({ trusted: true, ip: '198.51.100.1', geo: { country: 'KR', city: 'Seoul' } });
    expect(readProxyHeaders(r({ 'x-proxy-secret': 'nope', 'x-client-ip': '198.51.100.1' }), PROXY)).toEqual({ trusted: false, ip: null, geo: null });
    expect(readProxyHeaders(r({ 'x-proxy-secret': PROXY, 'x-client-ip': '198.51.100.1' }), undefined).trusted).toBe(false);
    expect(readProxyHeaders(r({ 'x-proxy-secret': PROXY, 'x-client-ip': '198.51.100.1' }), '').trusted).toBe(false);
    expect(parseIp('1.2.3.4, 5.6.7.8')).toBeNull();
    expect(parseIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(parseGeo('kr|Seoul')).toBeNull();
    expect(parseGeo('-|%E0%A4%A')).toEqual({ country: '-', city: '-' });
  });

  it('secureOtp：0～999999 的整数', () => {
    for (let i = 0; i < 200; i++) {
      const v = secureOtp();
      expect(Number.isInteger(v) && v >= 0 && v < 1_000_000).toBe(true);
    }
  });
});

describe('入口', () => {
  it('只收 POST；请求体不对回 400；缺密钥回 500 misconfigured', async () => {
    const w = await world();
    expect((await handle(req(null, {}, 'GET'), w.deps)).status).toBe(405);
    expect((await call(w, { step: 'start', email: 'bad', code: CODE, captchaToken: 'ok-token' })).status).toBe(400);
    expect((await call(w, { step: 'nope', email: 'a@b.cd', code: CODE })).status).toBe(400);
    expect((await call(w, 'just a string')).status).toBe(400);
    const w2 = await world({ hashSecret: undefined });
    const r = await call(w2, startBody('a@b.cd'));
    expect(r).toEqual({ status: 500, text: JSON.stringify({ error: 'misconfigured' }) });
  });

  it('X-App-Version 低于 min_client_version 回 426（第 6 节：函数里的第二道）；读不到配置放行', async () => {
    const w = await world();
    w.store.minVersion = '4.1.0';
    expect((await call(w, startBody('a@b.cd'), { ...viaProxy('203.0.113.7'), 'x-app-version': '4.0.9' })).status).toBe(426);
    expect((await call(w, startBody('a@b.cd'), viaProxy('203.0.113.7'))).status).toBe(426);
    expect((await call(w, startBody('a@b.cd'), { ...viaProxy('203.0.113.7'), 'x-app-version': '4.1.0-preview.2' })).status).toBe(200);
    w.store.minVersion = null;
    expect((await call(w, startBody('b@b.cd'))).status).toBe(200);
  });
});

describe('TC-B1-02：start 不泄露码对不对；没有 Turnstile 被拒', () => {
  it('有效码、错码、格式不对的码，响应完全一样；只有有效码发了信', async () => {
    const w = await world();
    const a = await call(w, startBody('a@example.com', CODE));
    const b = await call(w, startBody('b@example.com', 'ZZZZ2345ZZZZ'));
    const c = await call(w, startBody('c@example.com', 'short'));
    expect(a).toEqual({ status: 200, text: '{"ok":true}' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(w.mails.map((m) => m.to)).toEqual(['a@example.com']);
    expect(w.store.pending.size).toBe(1);
  });

  it('没带令牌、令牌不对都回 captcha_failed，不计数、不发信', async () => {
    const w = await world();
    const r1 = await call(w, { step: 'start', email: 'a@example.com', code: CODE, locale: 'zh-CN' });
    const r2 = await call(w, startBody('a@example.com', CODE, { captchaToken: 'bad-token' }));
    expect(JSON.parse(r1.text)).toEqual({ error: 'captcha_failed' });
    expect(JSON.parse(r2.text)).toEqual({ error: 'captcha_failed' });
    expect(w.store.counters.size).toBe(0);
    expect(w.mails).toHaveLength(0);
  });

  it('Turnstile 只在 secret 对时带上真实 IP；连不上 Cloudflare 回 503 try_later', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'), viaProxy('198.51.100.9'));
    await call(w, startBody('a@example.com'), { 'x-proxy-secret': 'forged', 'x-client-ip': '6.6.6.6' });
    expect(w.turnstile.mock.calls.map((c) => c[1])).toEqual(['198.51.100.9', null]);
    const w2 = await world({ verifyTurnstile: async () => { throw new Error('net'); } });
    expect(JSON.parse((await call(w2, startBody('a@example.com'))).text)).toEqual({ error: 'try_later' });
  });

  it('只存哈希：pending_signups 里没有邮箱和验证码原文；验证码 10 分钟、tries 从 0 起', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    const entries = [...w.store.pending.entries()];
    expect(entries).toHaveLength(1);
    const [eh, row] = entries[0] ?? ['', null];
    expect(eh).toBe(await emailHash(SECRET, 'a@example.com'));
    expect(JSON.stringify(row)).not.toContain(String(OTP));
    expect(row).toMatchObject({ tries: 0, expires_at: new Date(NOW + 600_000).toISOString() });
  });
});

describe('TC-B1-03：一次性码两个邮箱同时注册，只有一个成功', () => {
  it('used_count 比较并交换：并发两个 verify，一个拿到 token_hash，一个 invite_invalid', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    await call(w, startBody('b@example.com'));
    const [ra, rb] = await Promise.all([call(w, verifyBody('a@example.com')), call(w, verifyBody('b@example.com'))]);
    const results = [ra, rb].map((r) => ({ status: r.status, body: JSON.parse(r.text) as Record<string, unknown> }));
    expect(results.filter((r) => r.status === 200 && typeof r.body.token_hash === 'string')).toHaveLength(1);
    expect(results.filter((r) => r.body.error === 'invite_invalid')).toHaveLength(1);
    expect(w.store.invites.get(await inviteCodeHash(CODE))?.used_count).toBe(1);
    expect(w.auth.users.size).toBe(1);
  });

  it('能用 3 次的码：并发 5 个，恰好 3 个成功', async () => {
    const w = await world();
    const emails = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x}@example.com`);
    for (const e of emails) await call(w, startBody(e, CODE2), viaProxy(`203.0.113.${e.charCodeAt(0)}`));
    const rs = await Promise.all(emails.map((e) => call(w, verifyBody(e, String(OTP), CODE2))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
    expect(w.store.invites.get(await inviteCodeHash(CODE2))?.used_count).toBe(3);
  });
});

describe('TC-B1-04：验证码没过不建用户；createUser 失败退回邀请码', () => {
  it('验证码错：code_wrong，不建用户、不占码', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    const r = await call(w, verifyBody('a@example.com', '000000'));
    expect(JSON.parse(r.text)).toEqual({ error: 'code_wrong' });
    expect(w.auth.created).toHaveLength(0);
    expect(w.store.invites.get(await inviteCodeHash(CODE))?.used_count).toBe(0);
  });

  it('没发过码回 code_wrong（和填错一样）；验证码过期且填对回 410 code_expired，并删行', async () => {
    const w = await world();
    expect(JSON.parse((await call(w, verifyBody('nobody@example.com'))).text)).toEqual({ error: 'code_wrong' });
    await call(w, startBody('a@example.com'));
    w.deps.now = () => NOW + 600_000;
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(410);
    expect(JSON.parse(r.text)).toEqual({ error: 'code_expired' });
    expect(w.store.pending.size).toBe(0);
  });

  it('第二轮复审 Q1：过期 pending 配错误的验证码或邀请码，和“没有 pending”状态码、响应体完全一样；删行、不占次数', async () => {
    const none = await call(await world(), verifyBody('a@example.com', '000000'));
    const noneRight = await call(await world(), verifyBody('a@example.com'));
    expect(none).toEqual({ status: 400, text: '{"error":"code_wrong"}' });
    expect(noneRight).toEqual(none);
    const cases: [string, string][] = [['000000', CODE], ['12345', CODE], [String(OTP), CODE2]];
    for (const [otp, code] of cases) {
      const w = await world();
      await call(w, startBody('a@example.com'));
      const eh = await emailHash(SECRET, 'a@example.com');
      const tries = w.store.pending.get(eh)?.tries;
      expect(tries).toBe(0);
      w.deps.now = () => NOW + 600_000 + 1;
      const casSpy = vi.spyOn(w.store, 'casPendingTries');
      const r = await call(w, verifyBody('a@example.com', otp, code));
      expect(r).toEqual(none);
      expect(casSpy).not.toHaveBeenCalled();
      expect(w.store.pending.size).toBe(0);
      expect(w.auth.created).toHaveLength(0);
      // 删行以后再试：仍是同一个 code_wrong
      expect(await call(w, verifyBody('a@example.com'))).toEqual(none);
    }
  });

  it('第三轮复审：读到行之后、删除之前用户重新拿了新码 → 新码保留（过期分支和 too_many_tries 分支）', async () => {
    const eh = await emailHash(SECRET, 'a@example.com');
    const swapIn = (w: World) => () => {
      const old = w.store.pending.get(eh);
      if (old) w.store.pending.set(eh, { ...old, otp_hash: 'new-otp-hash', tries: 0, expires_at: new Date(NOW + 1_200_000).toISOString() });
      w.store.beforeDelete = null;
    };
    // 过期分支
    const a = await world();
    await call(a, startBody('a@example.com'));
    a.deps.now = () => NOW + 600_000;
    a.store.beforeDelete = swapIn(a);
    expect(JSON.parse((await call(a, verifyBody('a@example.com', '000000'))).text)).toEqual({ error: 'code_wrong' });
    expect(a.store.pending.get(eh)).toMatchObject({ otp_hash: 'new-otp-hash', tries: 0 });
    // too_many_tries 分支
    const b = await world();
    await call(b, startBody('a@example.com'));
    const row = b.store.pending.get(eh);
    if (row) row.tries = OTP_MAX_TRIES;
    b.store.beforeDelete = swapIn(b);
    expect(JSON.parse((await call(b, verifyBody('a@example.com'))).text)).toEqual({ error: 'too_many_tries' });
    expect(b.store.pending.get(eh)).toMatchObject({ otp_hash: 'new-otp-hash', tries: 0 });
    // 对照：没被换掉时照常删
    const c = await world();
    await call(c, startBody('a@example.com'));
    c.deps.now = () => NOW + 600_000;
    await call(c, verifyBody('a@example.com', '000000'));
    expect(c.store.pending.size).toBe(0);
  });

  it('第二轮复审：verify 先限流再版本门（被限流的旧版本也回 429，不读 app_config）', async () => {
    const w = await world();
    w.store.minVersion = '9.0.0';
    const minSpy = vi.spyOn(w.store, 'minClientVersion');
    const h = { ...viaProxy('198.51.100.9'), 'x-app-version': '1.0.0' };
    for (let i = 0; i < LIMIT_VERIFY_IP_PER_HOUR; i++) expect((await call(w, verifyBody('a@example.com'), h)).status).toBe(426);
    const over = await call(w, verifyBody('a@example.com'), h);
    expect(over.status).toBe(429);
    expect(JSON.parse(over.text)).toEqual({ error: 'rate_limited' });
    expect(minSpy).toHaveBeenCalledTimes(LIMIT_VERIFY_IP_PER_HOUR);
  });

  it('createUser 失败（桩）：码退回，可再用；修好后同一个码能注册成功', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    w.auth.failCreate = true;
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(503);
    expect(JSON.parse(r.text)).toEqual({ error: 'try_later' });
    expect(w.store.invites.get(await inviteCodeHash(CODE))?.used_count).toBe(0);
    w.auth.failCreate = false;
    const r2 = await call(w, verifyBody('a@example.com'));
    expect(r2.status).toBe(200);
    expect(w.store.invites.get(await inviteCodeHash(CODE))?.used_count).toBe(1);
  });

  it('建 profiles 失败：删掉刚建的用户、退回邀请码', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    w.store.failProfile = true;
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(503);
    expect(w.auth.deleted).toHaveLength(1);
    expect(w.auth.users.size).toBe(0);
    expect(w.store.invites.get(await inviteCodeHash(CODE))?.used_count).toBe(0);
  });

  it('邮箱已注册：先退回邀请码，再回 email_exists，不签发 magiclink', async () => {
    const w = await world();
    w.auth.users.set('a@example.com', USER);
    const link = vi.spyOn(w.auth, 'magiclinkTokenHash');
    await call(w, startBody('a@example.com'));
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text)).toEqual({ error: 'email_exists' });
    expect(link).not.toHaveBeenCalled();
    expect(w.store.invites.get(await inviteCodeHash(CODE))?.used_count).toBe(0);
  });

  it('成功：建用户不带密码（只传 email、locale）、建 profiles、删 pending、回 token_hash', async () => {
    const w = await world();
    await call(w, startBody('A@Example.com'));
    const r = await call(w, verifyBody('a@example.com', '123 456', 'abcd-2345-efgh', { locale: 'ko-KR' }));
    expect(r.status).toBe(200);
    const id = w.auth.users.get('a@example.com');
    expect(JSON.parse(r.text)).toEqual({ token_hash: `th-${id}` });
    expect(w.auth.created).toEqual([{ email: 'a@example.com', locale: 'ko-KR', args: 2 }]);
    expect(w.store.profiles).toEqual([{ userId: id, locale: 'ko-KR' }]);
    expect(w.store.pending.size).toBe(0);
  });

  it('邀请码在 start 之后被用掉或过期：invite_invalid，不建用户', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    const row = w.store.invites.get(await inviteCodeHash(CODE));
    if (row) row.expires_at = new Date(NOW - 1).toISOString();
    expect(JSON.parse((await call(w, verifyBody('a@example.com'))).text)).toEqual({ error: 'invite_invalid' });
    expect(w.auth.created).toHaveLength(0);
  });

  it('generateLink 失败：账号已建好，回 502 link_failed（客户端改走普通登录）', async () => {
    const w = await world();
    w.auth.failLink = true;
    await call(w, startBody('a@example.com'));
    const r = await call(w, verifyBody('a@example.com'));
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text)).toEqual({ error: 'link_failed' });
    expect(w.auth.users.size).toBe(1);
  });
});

describe('TC-B1-05：任何返回和邮件里都没有邀请人', () => {
  it('邀请码行带 created_by、note 也不出现在任何返回、邮件里；邮件不写“邀请人”', async () => {
    const w = await world();
    const h = await inviteCodeHash(CODE);
    w.store.invites.set(h, { ...(w.store.invites.get(h) as InviteRow), created_by: USER, note: '负责人张三' } as InviteRow);
    const outs = [await call(w, startBody('a@example.com')), await call(w, verifyBody('a@example.com', '000000')), await call(w, verifyBody('a@example.com'))];
    const all = JSON.stringify(outs) + JSON.stringify(w.mails);
    for (const bad of [USER, '张三', 'created_by', 'note', '邀请人', 'inviter']) expect(all).not.toContain(bad);
    for (const loc of ['zh-CN', 'ko-KR'] as const) {
      const m = signupMail(loc, '123456');
      expect(m.text).toContain('123456');
      expect(m.text + m.subject).not.toMatch(/邀请人|초대한|inviter/i);
    }
  });
});

describe('TC-B1-64：限流（函数一半）', () => {
  it('① 同一 IP 一小时第 11 次：照样回 {ok}，不发信，计数里看得到', async () => {
    const w = await world();
    const rs = [];
    for (let i = 0; i < LIMIT_IP_PER_HOUR + 1; i++) rs.push(await call(w, startBody(`u${i}@example.com`), viaProxy('198.51.100.1')));
    expect(rs.every((r) => r.text === '{"ok":true}')).toBe(true);
    expect(w.mails).toHaveLength(LIMIT_IP_PER_HOUR);
    const ipKey = [...w.store.counters.keys()].find((k) => k.startsWith('signup-ip:ip:') && !k.endsWith(UNTRUSTED_IP_BUCKET));
    expect(ipKey && w.store.counters.get(ipKey)).toBe(LIMIT_IP_PER_HOUR + 1);
    expect(ipKey).not.toContain('198.51.100.1');
    expect(w.logs).toContain('rate_ip');
  });

  it('② 同一邮箱一小时第 6 次（换 IP）：不发信', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_MAIL_PER_HOUR + 1; i++) await call(w, startBody('same@example.com'), viaProxy(`198.51.100.${i + 1}`));
    expect(w.mails).toHaveLength(LIMIT_MAIL_PER_HOUR);
    expect(w.store.counters.get(keys.mail(await emailHash(SECRET, 'same@example.com')))).toBe(LIMIT_MAIL_PER_HOUR + 1);
    expect(w.logs).toContain('rate_mail');
  });

  it('③ 全站一天第 51 次：不发信', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_GLOBAL_PER_DAY + 1; i++) await call(w, startBody(`g${i}@example.com`), viaProxy(`10.0.${Math.floor(i / 9)}.${i % 9}`));
    expect(w.mails).toHaveLength(LIMIT_GLOBAL_PER_DAY);
    expect(w.store.counters.get('signup:global:20261029')).toBe(LIMIT_GLOBAL_PER_DAY + 1);
    expect(w.logs).toContain('rate_global');
  });

  it('④ 验证码前 5 次填错、第 6 次填对也作废，要重新开始', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    const codes: string[] = [];
    for (let i = 0; i < OTP_MAX_TRIES; i++) codes.push((JSON.parse((await call(w, verifyBody('a@example.com', '000000'))).text) as { error: string }).error);
    expect(codes).toEqual(['code_wrong', 'code_wrong', 'code_wrong', 'code_wrong', 'too_many_tries']);
    const sixth = await call(w, verifyBody('a@example.com'));
    expect(JSON.parse(sixth.text)).toEqual({ error: 'too_many_tries' });
    expect(w.auth.created).toHaveLength(0);
    expect(w.store.pending.size).toBe(0);
    // 重新开始：新发一次码就能注册
    await call(w, startBody('a@example.com'));
    expect((await call(w, verifyBody('a@example.com'))).status).toBe(200);
  });

  it('④ 并发猜验证码不能多占尝试次数（tries 比较并交换）', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    await Promise.all(Array.from({ length: 8 }, () => call(w, verifyBody('a@example.com', '000000'))));
    const eh = await emailHash(SECRET, 'a@example.com');
    expect(w.store.pending.get(eh)?.tries ?? OTP_MAX_TRIES).toBeLessThanOrEqual(OTP_MAX_TRIES);
    // 用完 5 次后行可能已被删（回 code_wrong，和没有 pending 一样）或还在（回 too_many_tries）；填对也不放行
    const after = JSON.parse((await call(w, verifyBody('a@example.com'))).text) as { error?: string };
    expect(['too_many_tries', 'code_expired', 'code_wrong']).toContain(after.error);
    expect(w.auth.created).toHaveLength(0);
  });

  it('⑤ 伪造 x-client-ip（x-proxy-secret 不对）：每次换 IP 也只算进同一个不可信桶，第 11 次起不发信', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_IP_PER_HOUR + 3; i++) {
      await call(w, startBody(`f${i}@example.com`), { 'x-proxy-secret': 'forged', 'x-client-ip': `6.6.6.${i}`, 'x-forwarded-for': `7.7.7.${i}` });
    }
    expect(w.mails).toHaveLength(LIMIT_IP_PER_HOUR);
    expect(w.store.counters.get(keys.ip(UNTRUSTED_IP_BUCKET))).toBe(LIMIT_IP_PER_HOUR + 3);
    expect([...w.store.counters.keys()].filter((k) => k.startsWith('signup-ip:'))).toEqual([keys.ip(UNTRUSTED_IP_BUCKET)]);
  });

  it('前一道限流不过就不再往下计数（被刷的 IP 不消耗全站额度）', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_IP_PER_HOUR + 5; i++) await call(w, startBody(`u${i}@example.com`), viaProxy('198.51.100.1'));
    expect(w.store.counters.get('signup:global:20261029')).toBe(LIMIT_IP_PER_HOUR);
  });
});

describe('日志只记错误码（A23）', () => {
  it('整套流程的日志里没有邮箱、验证码、邀请码、IP', async () => {
    const w = await world({ sendMail: async () => false });
    await call(w, startBody('secret.person@example.com'), viaProxy('198.51.100.77'));
    await call(w, verifyBody('secret.person@example.com', '000000'));
    w.auth.failCreate = true;
    await call(w, verifyBody('secret.person@example.com'));
    const all = w.logs.join('\n');
    expect(w.logs).toContain('mail_failed');
    expect(w.logs).toContain('create_user_failed');
    for (const bad of ['secret.person', '123456', CODE, '198.51.100.77']) expect(all).not.toContain(bad);
    expect(w.logs.every((l) => /^[a-z_]+$/.test(l))).toBe(true);
  });

  it('数据库出错：回 503 try_later，日志只有 db_error', async () => {
    const w = await world();
    w.store.takeRate = async () => { throw new Error('connect ECONNREFUSED postgres://secret@host'); };
    const r = await call(w, startBody('a@example.com'));
    expect(r.status).toBe(503);
    expect(w.logs).toEqual(['db_error']);
  });
});

describe('K2 安全审查回归（P1～P5、低 2～6）', () => {
  it('P1 verify 按 IP 限流：同一 IP 每小时第 31 次回 429 rate_limited，且不消耗受害人的尝试次数', async () => {
    const w = await world();
    await call(w, startBody('victim@example.com'), viaProxy('198.51.100.5'));
    const attacker = viaProxy('203.0.113.66');
    for (let i = 0; i < LIMIT_VERIFY_IP_PER_HOUR; i++) await call(w, verifyBody(`x${i}@example.com`, '000000'), attacker);
    const over = await call(w, verifyBody('victim@example.com', '000000'), attacker);
    expect(over.status).toBe(429);
    expect(JSON.parse(over.text)).toEqual({ error: 'rate_limited' });
    expect(w.store.pending.get(await emailHash(SECRET, 'victim@example.com'))?.tries).toBe(0);
    expect((await call(w, verifyBody('victim@example.com'), viaProxy('198.51.100.5'))).status).toBe(200);
  });

  it('P1 不可信来源的 verify 进同一个共用桶：伪造 IP 换不出新额度', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_VERIFY_IP_PER_HOUR + 2; i++) {
      await call(w, verifyBody(`x${i}@example.com`, '000000'), { 'x-proxy-secret': 'forged', 'x-client-ip': `6.6.6.${i}` });
    }
    expect(w.store.counters.get(keys.verifyIp(UNTRUSTED_IP_BUCKET))).toBe(LIMIT_VERIFY_IP_PER_HOUR + 2);
    expect(keys.verifyIp(UNTRUSTED_IP_BUCKET)).toMatch(COUNTER_KEY);
  });

  it('P1 没有 pending 和填错：状态码、响应体完全一样', async () => {
    const w = await world();
    await call(w, startBody('has@example.com'));
    const none = await call(w, verifyBody('none@example.com', '000000'));
    const wrong = await call(w, verifyBody('has@example.com', '000000'));
    expect(none).toEqual(wrong);
    expect(none).toEqual({ status: 400, text: '{"error":"code_wrong"}' });
  });

  it('P2 验证码和邀请码绑定：start 用 CODE，verify 换成 CODE2 填对验证码也是 code_wrong，CODE2 不被占', async () => {
    const w = await world();
    await call(w, startBody('me@example.com', CODE));
    const r = await call(w, verifyBody('me@example.com', String(OTP), CODE2));
    expect(JSON.parse(r.text)).toEqual({ error: 'code_wrong' });
    expect(w.store.invites.get(await inviteCodeHash(CODE2))?.used_count).toBe(0);
    expect(w.auth.created).toHaveLength(0);
  });

  it('P3 IPv6 按 /64 计：同一个 /64 换地址第 11 次被拒；不同 /64 互不影响', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_IP_PER_HOUR + 1; i++) await call(w, startBody(`m${i}@example.com`), viaProxy(`2001:db8:0:1::${(i + 1).toString(16)}`));
    expect(w.mails).toHaveLength(LIMIT_IP_PER_HOUR);
    await call(w, startBody('other@example.com'), viaProxy('2001:db8:0:2::1'));
    expect(w.mails).toHaveLength(LIMIT_IP_PER_HOUR + 1);
  });

  it('P3 rateIp：IPv6 展开后取前 64 位；::ffff:a.b.c.d 当 IPv4；不合法返回 null', () => {
    expect(rateIp('2001:DB8:0:1:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:0:1::/64');
    expect(rateIp('2001:db8:0:1::5')).toBe('2001:db8:0:1::/64');
    expect(rateIp('2001:0db8:0000:0001::')).toBe('2001:db8:0:1::/64');
    expect(rateIp('::1')).toBe('0:0:0:0::/64');
    expect(rateIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(rateIp('::FFFF:c633:6407')).toBe('198.51.100.7');
    expect(rateIp('64:ff9b::198.51.100.7')).toBe('64:ff9b:0:0::/64');
    expect(rateIp('198.51.100.7')).toBe('198.51.100.7');
    for (const bad of ['1::2::3', '2001:db8:1:2:3:4:5:6:7', '12345::', 'gggg::1', '1.2.3', '']) expect(rateIp(bad), bad).toBeNull();
  });

  it('P3 ::ffff:a.b.c.d 和 a.b.c.d 算同一个 IP', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_IP_PER_HOUR; i++) await call(w, startBody(`p${i}@example.com`), viaProxy('198.51.100.8'));
    await call(w, startBody('q@example.com'), viaProxy('::ffff:198.51.100.8'));
    expect(w.mails).toHaveLength(LIMIT_IP_PER_HOUR);
  });

  it('P4 全站额度只数真正要发的信：50 个错码之后，有效码照样发信', async () => {
    const w = await world();
    for (let i = 0; i < LIMIT_GLOBAL_PER_DAY; i++) await call(w, startBody(`j${i}@example.com`, 'ZZZZ2345ZZZZ'), viaProxy(`10.0.${Math.floor(i / 9)}.${i % 9}`));
    expect(w.store.counters.get(keys.global(NOW))).toBeUndefined();
    const r = await call(w, startBody('real@example.com', CODE), viaProxy('9.9.9.9'));
    expect(r.text).toBe('{"ok":true}');
    expect(w.mails.map((m) => m.to)).toEqual(['real@example.com']);
  });

  it('P5 建 profile 失败、删用户也失败：不退码，回 503 try_later，记 orphan_user', async () => {
    const w = await world();
    await call(w, startBody('o@example.com'));
    w.store.failProfile = true;
    w.auth.failDelete = true;
    const r = await call(w, verifyBody('o@example.com'));
    expect(r).toEqual({ status: 503, text: '{"error":"try_later"}' });
    // 只记 user_id 的前 8 位（架构 0.38）
    expect(w.logs).toContain('orphan_user:aaaaaaaa');
    expect(w.logs.join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(w.store.invites.get(await inviteCodeHash(CODE))?.used_count).toBe(1);
  });

  it('低 3：没配 PROXY_SECRET——正式环境 misconfigured；预览环境照常处理，只记 proxy_secret_missing', async () => {
    const prod = await world({ proxySecret: undefined });
    expect(await call(prod, startBody('a@example.com'))).toEqual({ status: 500, text: '{"error":"misconfigured"}' });
    const turn = vi.fn(async (): Promise<TurnstileResult> => ({ success: true, hostname: 'preview.lemomemo.com', action: 'invite_start' }));
    const pre = await world({ proxySecret: undefined, env: 'preview', verifyTurnstile: turn });
    expect((await call(pre, startBody('a@example.com'))).text).toBe('{"ok":true}');
    expect(pre.logs).toContain('proxy_secret_missing');
    expect(pre.mails).toHaveLength(1);
    expect(pre.store.counters.get(keys.ip(UNTRUSTED_IP_BUCKET))).toBe(1);
  });

  it('低 4：读完 pending 之后同一邮箱重新发了码，旧的那次读不会把尝试记到新码上', async () => {
    const w = await world();
    await call(w, startBody('a@example.com'));
    const eh = await emailHash(SECRET, 'a@example.com');
    const stale = { ...(w.store.pending.get(eh) as PendingRow) };
    w.deps.randomOtp = () => 654321;
    await call(w, startBody('a@example.com'));
    const real = w.store.getPending.bind(w.store);
    let first = true;
    w.store.getPending = async (h: string) => { if (first) { first = false; return { ...stale }; } return real(h); };
    expect((await call(w, verifyBody('a@example.com', '654321'))).status).toBe(200);
  });

  it('低 5：Turnstile 的 hostname、action 对不上一律 captcha_failed，不计数、不发信', async () => {
    const cases: TurnstileResult[] = [
      { success: true, hostname: 'evil.example', action: 'invite_start' },
      { success: true, hostname: 'preview.lemomemo.com', action: 'invite_start' },   // 正式环境不认预览域名
      { success: true, hostname: 'lemomemo.com', action: 'login' },
      { success: true, hostname: 'lemomemo.com', action: 'invite' },   // 0.38 起 start 的 action 是 invite_start
      { success: true, hostname: 'lemomemo.com', action: null },
      { success: false, hostname: 'lemomemo.com', action: 'invite_start' },
    ];
    for (const t of cases) {
      const w = await world({ verifyTurnstile: async () => t });
      const r = await call(w, startBody('a@example.com'));
      expect(r, JSON.stringify(t)).toEqual({ status: 403, text: '{"error":"captcha_failed"}' });
      expect(w.store.counters.size).toBe(0);
      expect(w.mails).toHaveLength(0);
    }
  });

  it('低 6：版本门在 Turnstile 之后——没过人机校验先回 captcha_failed，不读配置', async () => {
    const w = await world();
    w.store.minVersion = '9.0.0';
    const spy = vi.spyOn(w.store, 'minClientVersion');
    const r = await call(w, startBody('a@example.com', CODE, { captchaToken: 'bad-token' }), { ...viaProxy('203.0.113.7'), 'x-app-version': '1.0.0' });
    expect(JSON.parse(r.text)).toEqual({ error: 'captcha_failed' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('环境判断 _shared/env-kind.ts 和本机调试', () => {
  it('envKind：预览 ref 才是预览；127.0.0.1、localhost、kong 是本机；其余（含拿不准的）一律正式', () => {
    expect(envKind(`https://${PREVIEW_REF}.supabase.co`)).toBe('preview');
    expect(envKind(`https://${PREVIEW_REF}.supabase.co/`)).toBe('preview');
    expect(envKind('http://127.0.0.1:54321')).toBe('local');
    expect(envKind('http://localhost:54321')).toBe('local');
    expect(envKind('http://kong:8000')).toBe('local');
    for (const u of ['https://abcdefghijklmnopqrst.supabase.co', `https://x${PREVIEW_REF}.supabase.co`,
      `https://${PREVIEW_REF}.supabase.co.evil.example`, 'http://localhost.evil.example', 'http://kong.evil.example',
      PREVIEW_REF, '', undefined, null]) {
      expect(envKind(u), String(u)).toBe('prod');
    }
  });

  it('本机环境：Turnstile hostname 是 localhost、127.0.0.1 时放行；action 照样核对', async () => {
    for (const host of ['localhost', '127.0.0.1']) {
      const w = await world({ env: 'local', verifyTurnstile: async () => ({ success: true, hostname: host, action: 'invite_start' }) });
      expect((await call(w, startBody('a@example.com'))).text, host).toBe('{"ok":true}');
      expect(w.mails).toHaveLength(1);
    }
    const bad = await world({ env: 'local', verifyTurnstile: async () => ({ success: true, hostname: 'localhost', action: 'login' }) });
    expect((await call(bad, startBody('a@example.com'))).status).toBe(403);
  });

  it('正式环境：Turnstile hostname 是 localhost 时拒绝', async () => {
    for (const host of ['localhost', '127.0.0.1']) {
      const w = await world({ env: 'prod', verifyTurnstile: async () => ({ success: true, hostname: host, action: 'invite_start' }) });
      expect(await call(w, startBody('a@example.com')), host).toEqual({ status: 403, text: '{"error":"captcha_failed"}' });
      expect(w.mails).toHaveLength(0);
    }
  });

  it('本机环境没配 PROXY_SECRET：照常处理，只记 proxy_secret_missing', async () => {
    const w = await world({ env: 'local', proxySecret: undefined, verifyTurnstile: async () => ({ success: true, hostname: 'localhost', action: 'invite_start' }) });
    expect((await call(w, startBody('a@example.com'))).text).toBe('{"ok":true}');
    expect(w.logs).toContain('proxy_secret_missing');
  });
});
