// invite-signup 的单元测试（续，B1 第九批从 invite-signup.test.ts 拆出）：TC-B1-64 限流（函数一半）和 K2 安全审查回归（P1～P5、低 2～6）。
// 只测 core.ts，假库、假 Auth 见 invite-signup-harness.ts。
import { describe, expect, it, vi } from 'vitest';
import {
  keys, signupUserId, LIMIT_GLOBAL_PER_DAY, LIMIT_IP_PER_HOUR, LIMIT_MAIL_PER_HOUR, LIMIT_VERIFY_IP_PER_HOUR, OTP_MAX_TRIES, UNTRUSTED_IP_BUCKET,
  type PendingRow, type TurnstileResult,
} from '../../supabase/functions/invite-signup/core.ts';
import { emailHash } from '../../supabase/functions/_shared/email-hash.ts';
import { inviteCodeHash } from '../../supabase/functions/_shared/invite-code.ts';
import { rateIp } from '../../supabase/functions/_shared/proxy-headers.ts';
import { NOW, SECRET, CODE, CODE2, OTP, COUNTER_KEY, world, viaProxy, startBody, verifyBody, call } from './invite-signup-harness.ts';

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
    expect(w.logs).toContain(`orphan_user:${w.auth.ids[0]?.slice(0, 8)}`);
    expect(w.logs.filter((l) => l.startsWith('orphan_user:')).every((l) => /^orphan_user:[0-9a-f]{8}$/.test(l))).toBe(true);
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

// INVITE-auth-timeout 的用户 id 派生（代码审查增量复核 1 起由邮箱哈希 + 码哈希派生；从 invite-late-commit.test.ts 挪来）
describe('signupUserId', () => {
  it('由邮箱哈希 + 码哈希派生：同一邮箱同一个码同一个 id（与验证码无关）；换邮箱、换码、换密钥都换；是 UUID v4 格式', async () => {
    const eh = 'a'.repeat(64);
    const ch = 'c'.repeat(64);
    const a = await signupUserId('s1', eh, ch);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await signupUserId('s1', eh, ch)).toBe(a);
    expect(await signupUserId('s1', 'b'.repeat(64), ch)).not.toBe(a);
    expect(await signupUserId('s1', eh, 'd'.repeat(64))).not.toBe(a);
    expect(await signupUserId('s2', eh, ch)).not.toBe(a);
    // 派生只吃哈希：签名就是 (secret, eh, codeHash)，调用处传的是 email_hash、code_hash（core.ts verify）
    expect(signupUserId.length).toBe(3);
  });
});
