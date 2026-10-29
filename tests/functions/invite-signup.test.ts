// invite-signup 的单元测试（架构 5.6、第 6 节、15.2 中 1 ④、附录 A counters 键表）：TC-B1-02、03、04、05、64 的函数一半。
// 只测 core.ts（index.ts 只是把 supabase-js、Turnstile、Resend 接上），数据库和 Auth 由假对象代替（invite-signup-harness.ts）；
// 假 invites、pending_signups 的比较并交换和真 UPDATE … WHERE 同一个语义，take_rate 和迁移同一个口径（先计数再判断）。
// take_rate 本身在 supabase/tests/rls/08_take_rate.test.sql。
// 这一份：共享模块、入口、TC-B1-02、03、05、环境判断；TC-B1-04 和日志在 invite-signup-verify.test.ts，
// TC-B1-64 限流和 K2 安全审查回归在 invite-signup-security.test.ts（B1 第九批按主题拆开）。
import { describe, expect, it } from 'vitest';
import { handle, keys, secureOtp, signupMail, utcDate, UNTRUSTED_IP_BUCKET, type InviteRow } from '../../supabase/functions/invite-signup/core.ts';
import { emailHash } from '../../supabase/functions/_shared/email-hash.ts';
import { INVITE_ALPHABET, inviteCodeHash, isInviteCode } from '../../supabase/functions/_shared/invite-code.ts';
import { envKind, PREVIEW_REF } from '../../supabase/functions/_shared/env-kind.ts';
import { parseGeo, parseIp, readProxyHeaders } from '../../supabase/functions/_shared/proxy-headers.ts';
import {
  NOW, SECRET, PROXY, CODE, CODE2, OTP, USER, COUNTER_KEY, world, req, viaProxy, startBody, verifyBody, call,
} from './invite-signup-harness.ts';

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
