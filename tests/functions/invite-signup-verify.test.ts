// invite-signup 的单元测试（续，B1 第九批从 invite-signup.test.ts 拆出）：TC-B1-04 验证码没过不建用户、createUser 失败退回邀请码，
// 以及日志只记错误码（A23）。只测 core.ts，假库、假 Auth 见 invite-signup-harness.ts。
import { describe, expect, it, vi } from 'vitest';
import { LIMIT_VERIFY_IP_PER_HOUR, OTP_MAX_TRIES } from '../../supabase/functions/invite-signup/core.ts';
import { emailHash } from '../../supabase/functions/_shared/email-hash.ts';
import { inviteCodeHash } from '../../supabase/functions/_shared/invite-code.ts';
import { NOW, SECRET, CODE, CODE2, OTP, USER, type World, world, viaProxy, startBody, verifyBody, call } from './invite-signup-harness.ts';

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
    expect(w.auth.created).toEqual([{ email: 'a@example.com', locale: 'ko-KR', args: 3 }]);
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
