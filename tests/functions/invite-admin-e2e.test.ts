// invite-admin 端到端单测（安全审查建议）：invite-admin 发出的码直接交给 invite-signup 的 handle，start → verify 能走通，只能用 1 次。
// 两边的 core.ts 都是真的，只有库是假的：两个函数共用同一张假 invites 表（invite-admin 写、invite-signup 读和占用）。
import { describe, expect, it } from 'vitest';
import {
  handle as signupHandle, type Deps as SignupDeps, type InviteRow, type PendingRow, type Store as SignupStore,
} from '../../supabase/functions/invite-signup/core.ts';
import { call, FakeStore, NOW } from './invite-admin-fakes.ts';

describe('端到端：invite-admin 发出的码交给 invite-signup 能注册成功', () => {
  it('同一张假 invites 表：admin 写进去的行，signup 的 start → verify 读得到、占用一次；用完以后别人再拿这个码 start 不发信', async () => {
    const admin = new FakeStore();
    const { res } = await call(admin, { action: 'create', note: '10-29 e2e' });
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };

    // invite-signup 的假库：invites 直接读 invite-admin 写的那张（同一个 Map，按 code_hash）
    const pending = new Map<string, PendingRow>();
    const mails: string[] = [];
    let users = 0;
    const store: SignupStore = {
      takeRate: async () => true,
      getInvite: async (h) => {
        const r = admin.invites.get(h);
        return r ? ({ max_uses: r.max_uses, used_count: r.used_count, expires_at: r.expires_at } satisfies InviteRow) : null;
      },
      casInviteUsed: async (h, from, to, notExpiredAt) => {
        const r = admin.invites.get(h);
        if (!r || r.used_count !== from) return false;
        if (notExpiredAt && !(Date.parse(r.expires_at) > Date.parse(notExpiredAt))) return false;
        r.used_count = to;
        return true;
      },
      putPending: async (eh, row) => { pending.set(eh, { ...row }); },
      getPending: async (eh) => { const r = pending.get(eh); return r ? { ...r } : null; },
      casPendingTries: async (eh, from, to, otpHash) => {
        const r = pending.get(eh);
        if (!r || r.tries !== from || r.otp_hash !== otpHash) return false;
        r.tries = to;
        return true;
      },
      deletePending: async (eh) => { pending.delete(eh); },
      insertProfile: async () => {},
      minClientVersion: async () => null,
    };
    const signupDeps: SignupDeps = {
      store,
      auth: {
        createUser: async () => ({ ok: true, userId: `cccccccc-0000-4000-8000-00000000000${++users}` }),
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
  });
});
