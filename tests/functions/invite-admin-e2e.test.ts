// invite-admin 端到端单测（安全审查建议）：invite-admin 发出的码直接交给 invite-signup 的 handle，start → verify 能走通，只能用 1 次。
// 两边的 core.ts 都是真的，只有库是假的：两个函数共用同一张假 invites 表（invite-admin 写、invite-signup 读和占用）。
// 作废（11-27）：invite-admin revoke 以后，start 不再发信，作废前已发验证码的 verify 也占不上码。
import { describe, expect, it } from 'vitest';
import {
  handle as signupHandle, type Deps as SignupDeps, type InviteRow, type PendingRow, type Store as SignupStore,
} from '../../supabase/functions/invite-signup/core.ts';
import { call, FakeStore, NOW } from './invite-admin-fakes.ts';

/** invite-signup 接在 invite-admin 的同一张假 invites 表上：返回调 signup 的函数和发出去的信 */
function signupOn(admin: FakeStore) {
  // invite-signup 的假库：invites 直接读 invite-admin 写的那张（同一个 Map，按 code_hash）
  const pending = new Map<string, PendingRow>();
  const mails: string[] = [];
  const store: SignupStore = {
    takeRate: async () => true,
    getInvite: async (h) => {
      const r = admin.invites.get(h);
      return r ? ({ max_uses: r.max_uses, used_count: r.used_count, expires_at: r.expires_at } satisfies InviteRow) : null;
    },
    // 占码、退码照迁移 20261031150000 的 invite_claim、invite_release（这里只走成功的一条路）
    claimInvite: async (eh, otpHash, h, notExpiredAt) => {
      const p = pending.get(eh);
      if (!p || p.otp_hash !== otpHash) return 'no_pending';
      const r = admin.invites.get(h);
      if (!r || r.used_count >= r.max_uses || !(Date.parse(r.expires_at) > Date.parse(notExpiredAt))) return 'invalid';
      r.used_count += 1;
      return 'ok';
    },
    releaseInvite: async () => false,
    putPending: async (eh, row) => { pending.set(eh, { ...row }); },
    getPending: async (eh) => { const r = pending.get(eh); return r ? { ...r } : null; },
    casPendingTries: async (eh, from, to, otpHash) => {
      const r = pending.get(eh);
      if (!r || r.tries !== from || r.otp_hash !== otpHash) return false;
      r.tries = to;
      return true;
    },
    deletePending: async (eh) => { pending.delete(eh); },
    insertProfile: async () => true,
    minClientVersion: async () => null,
  };
  const signupDeps: SignupDeps = {
    store,
    auth: {
      createUser: async (id) => ({ ok: true, userId: id }),
      userExists: async () => false,
      deleteUser: async () => {},
      magiclinkTokenHash: async () => 'token-hash-e2e',
    },
    env: 'prod',
    verifyTurnstile: async () => ({ success: true, hostname: 'lemomemo.com', action: 'invite_start' }),
    sendMail: async (to) => { mails.push(to); return true; },
    hashSecret: 'test-hash-secret',
    proxySecret: 'test-proxy-secret',
    configured: true,
    now: () => NOW + 60_000,
    randomOtp: () => 123456,
  };
  const signup = (body: unknown) => signupHandle(new Request('https://x.supabase.co/functions/v1/invite-signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proxy-secret': 'test-proxy-secret', 'x-client-ip': '203.0.113.7' },
    body: JSON.stringify(body),
  }), signupDeps);
  return { signup, mails };
}

async function issue(admin: FakeStore, note: string): Promise<string> {
  const { res } = await call(admin, { action: 'create', note });
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

async function revokeByNote(admin: FakeStore, note: string): Promise<number> {
  const l = await call(admin, { action: 'list' });
  const id = ((await l.res.json()) as { invites: { id: string; note: string }[] }).invites.find((r) => r.note === note)?.id;
  return (await call(admin, { action: 'revoke', id })).res.status;
}

describe('端到端：invite-admin 发出的码交给 invite-signup 能注册成功', () => {
  it('同一张假 invites 表：admin 写进去的行，signup 的 start → verify 读得到、占用一次；用完以后别人再拿这个码 start 不发信', async () => {
    const admin = new FakeStore();
    const code = await issue(admin, '10-29 e2e');
    const { signup, mails } = signupOn(admin);

    // 用户输入时常带横线、小写：invite-signup 自己规范化
    const typed = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`.toLowerCase();
    const s = await signup({ step: 'start', email: 'new@example.com', code: typed, captchaToken: 't', locale: 'zh-CN' });
    expect(s.status).toBe(200);
    expect(mails).toEqual(['new@example.com']);   // 码有效才会发信
    const v = await signup({ step: 'verify', email: 'new@example.com', code: typed, email_otp: '123456' });
    expect(v.status).toBe(200);
    expect(await v.json()).toEqual({ token_hash: 'token-hash-e2e' });
    expect([...admin.invites.values()][0]?.used_count).toBe(1);

    // 只能用 1 次：另一个邮箱再拿同一个码，start 照样回 {ok} 但不发信（码已用完）
    const s2 = await signup({ step: 'start', email: 'other@example.com', code, captchaToken: 't', locale: 'zh-CN' });
    expect(s2.status).toBe(200);
    expect(mails).toEqual(['new@example.com']);
    // 已用掉的码不能作废
    expect(await revokeByNote(admin, '10-29 e2e')).toBe(404);
  });

  it('作废以后马上不能注册：start 照样回 {ok} 但不发信；作废前已经 start、收到验证码的，verify 回 invite_invalid、不建用户、码没被占', async () => {
    const admin = new FakeStore();
    const early = await issue(admin, '11-27 先发了验证码');
    const late = await issue(admin, '11-27 作废后才来');
    const { signup, mails } = signupOn(admin);
    const s = await signup({ step: 'start', email: 'early@example.com', code: early, captchaToken: 't', locale: 'zh-CN' });
    expect(s.status).toBe(200);
    expect(mails).toEqual(['early@example.com']);

    expect(await revokeByNote(admin, '11-27 先发了验证码')).toBe(200);
    expect(await revokeByNote(admin, '11-27 作废后才来')).toBe(200);

    const v = await signup({ step: 'verify', email: 'early@example.com', code: early, email_otp: '123456' });
    expect(v.status).toBe(400);
    expect(await v.json()).toEqual({ error: 'invite_invalid' });
    const s2 = await signup({ step: 'start', email: 'late@example.com', code: late, captchaToken: 't', locale: 'zh-CN' });
    expect(s2.status).toBe(200);
    expect(mails).toEqual(['early@example.com']);   // 作废的码不发信
    expect([...admin.invites.values()].map((r) => r.used_count)).toEqual([0, 0]);
  });
});
