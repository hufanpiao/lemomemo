// account 函数的单元测试（B1 K3；架构第 6 节 account、0.29 续第 92～96、129、131、134、137、138 条）：
// TC-B1-95 ③、98、99 ②（导出被拒）、100 ②④⑤⑧、103 ①②、104 ①、107 ③（邮件不放链接）的函数一半。
// 只测 core.ts（index.ts 只是把 supabase-js、requireActiveUser、Resend 接上）；数据库一半在 supabase/tests/rls/11_account_deletion.test.sql。
// export 一组在 account-export.test.ts，status 一组在 account-status.test.ts（ACCOUNT-sugg ①，max-lines）；
//   共用的 setup（accountSetup）、call（callAccount）、COUNTER_KEY 在 account-fakes.ts。
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DAILY_LIMIT, ACCOUNT_ERRS, confirmOk, handle, keys, otpFresh, RESTORE_DAILY_LIMIT,
} from '../../supabase/functions/account/core.ts';
import { ACCOUNT_ERROR_CODES, accountErrorCode } from '../../shared/schema/account.ts';
import {
  deletionDoneMail, deletionReminderMail, deletionRequestedMail, exportMail, fmtWhen, restoredMail, safeTz,
} from '../../supabase/functions/_shared/account-mail.ts';
import { A, accountDeps, accountReq, B, accountSetup as setup, callAccount as call, COUNTER_KEY, DAY, H, T0 } from './account-fakes.ts';

describe('计数键、确认词、amr', () => {
  it('两个计数键过得了 counters 的 check 约束（附录 A：account、restore 按 UTC 日期）', () => {
    expect(keys.account(A, T0)).toBe(`account:${A}:20261029`);
    expect(keys.restore(A, T0)).toBe(`restore:${A}:20261029`);
    for (const k of [keys.account(A, T0), keys.restore(A, T0)]) expect(k).toMatch(COUNTER_KEY);
  });

  it('确认词（TC-B1-95 ②③）：去掉首尾空白后等于“注销”或“탈퇴”才算', () => {
    for (const ok of ['注销', ' 注销 ', '탈퇴', '\n탈퇴\t']) expect(confirmOk(ok), ok).toBe(true);
    for (const bad of [undefined, null, '', '注消', 'delete', '注销账号', '注 销', '注销。', 1, ['注销']]) expect(confirmOk(bad), String(bad)).toBe(false);
  });

  it('otp 在 10 分钟以内才算（只认 otp，取最近一次；允许 1 分钟时钟误差）', () => {
    const now = T0;
    const s = Math.floor(now / 1000);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s - 599 }]), now)).toBe(true);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s - 601 }]), now)).toBe(false);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s - 3000 }, { method: 'otp', timestamp: s - 10 }]), now)).toBe(true);
    expect(otpFresh(jwt([{ method: 'magiclink', timestamp: s - 10 }]), now)).toBe(false);
    expect(otpFresh(jwt([{ method: 'password', timestamp: s - 10 }]), now)).toBe(false);
    expect(otpFresh(jwt(['otp']), now)).toBe(false);
    expect(otpFresh(jwt(undefined), now)).toBe(false);
    expect(otpFresh('not-a-jwt', now)).toBe(false);
    expect(otpFresh(jwt([{ method: 'otp', timestamp: s + 600 }]), now)).toBe(false);   // 未来很远：不信
  });
});

function jwt(amr: unknown): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: A, amr })}.sig`;
}

describe('account delete（申请注销）', () => {
  it('TC-B1-95 ③：confirm 不对一律 confirm_required，一条都不写（不计次数、没有 pending_deletions、disabled_at 不变）', async () => {
    const { db, box } = setup();
    for (const confirm of [undefined, '', 'delete', '注销账号', '注消']) {
      const body = confirm === undefined ? { action: 'delete' } : { action: 'delete', confirm };
      const r = await call(db, box, body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'confirm_required' });
    }
    expect(db.pending.size).toBe(0);
    expect(db.profiles.get(A)?.disabled_at).toBeNull();
    expect(db.counters.size).toBe(0);
    expect(box).toEqual([]);
  });

  it('TC-B1-98：申请成功 → 冷静期（purge_after = +7 天、停用 deletion、全部会话吊销），数据不删，发第一封信', async () => {
    const { db, box } = setup();
    db.tables.set('settings', [{ id: 's1', user_id: A }]);
    const r = await call(db, box, { action: 'delete', confirm: ' 注销 ' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = (await r.json()) as { ok: boolean; purge_after: string };
    expect(j.ok).toBe(true);
    expect(Date.parse(j.purge_after)).toBe(T0 + 7 * DAY);
    expect(db.pending.get(A)?.purge_after).toBe(j.purge_after);
    expect(db.profiles.get(A)).toMatchObject({ disabled_reason: 'deletion' });
    expect([...db.sessions.values()]).not.toContain(A);
    expect([...db.revoked.values()].filter((u) => u === A)).toHaveLength(2);
    expect(db.deleted.size).toBe(0);
    expect(db.tables.get('settings')).toHaveLength(1);
    // 第一封信：时刻按本人时区（首尔），和 purge_after 一致；正文没有链接
    expect(box).toHaveLength(1);
    expect(box[0]?.to).toBe('a@test.local');
    expect(box[0]?.mail.text).toContain(fmtWhen(T0 + 7 * DAY, 'Asia/Seoul', 'zh-CN'));
    expect(box[0]?.mail.text).toContain('2026年11月5日 12:00（Asia/Seoul）');
    expect(box[0]?.mail.text).toContain('恢复账号');
    expect(box[0]?.mail.text).not.toMatch(/http|www\.|lemomemo\./i);
  });

  it('韩文界面的人收韩文信（ui_locale = ko-KR）', async () => {
    const { db, box } = setup();
    const r = await call(db, box, { action: 'delete', confirm: '탈퇴' }, { user: B });
    expect(r.status).toBe(200);
    expect(box[0]?.mail.text).toContain('2026년 11월 5일 12:00 (Asia/Seoul)');
  });

  it('TC-B1-103 ①：管理员申请注销回 admin_cannot_delete，什么都不写', async () => {
    const { db, box } = setup();
    db.admins.add(A);
    const r = await call(db, box, { action: 'delete', confirm: '注销' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'admin_cannot_delete' });
    expect(db.pending.size).toBe(0);
    expect(db.profiles.get(A)?.disabled_at).toBeNull();
    expect(box).toEqual([]);
  });

  it('rpc 那一道拦下的管理员（并发时刚加进 admins）也回 admin_cannot_delete', async () => {
    const { db, box } = setup();
    const store = db.accountStore();
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { store: { ...store, isAdmin: async () => false, requestDeletion: async () => { db.admins.add(A); return db.requestDeletion(A); } } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'admin_cannot_delete' });
  });

  it('TC-B1-65 ③：export、delete 合计每天 3 次：第 4 次 rate_limited，不进冷静期', async () => {
    const { db, box } = setup();
    for (let i = 0; i < ACCOUNT_DAILY_LIMIT; i++) expect((await call(db, box, { action: 'export', step: 'start' })).status).toBe(200);
    const r = await call(db, box, { action: 'delete', confirm: '注销' });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(db.pending.size).toBe(0);
  });

  it('冷静期里再调 delete：被 requireActiveUser 拦成 account_pending_deletion（带 purge_after）', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { session: 'aaaaaaaa-s3' });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'account_pending_deletion', purge_after: db.pending.get(A)?.purge_after });
  });

  it('发信失败不影响申请成功（只记错误码）', async () => {
    const { db, box } = setup();
    const logs: string[] = [];
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { sendMail: async () => false, log: (c) => logs.push(c) });
    expect(r.status).toBe(200);
    expect(db.pending.has(A)).toBe(true);
    expect(logs).toContain('mail_failed:requested');
  });

  it('数据库出错：503 try_later，日志只有错误码', async () => {
    const { db, box } = setup();
    db.fail.add('requestDeletion');
    const logs: string[] = [];
    const r = await call(db, box, { action: 'delete', confirm: '注销' }, { log: (c) => logs.push(c) });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(logs).toEqual(['db_error']);
  });
});

describe('account restore（冷静期里恢复）', () => {
  async function pendingA() {
    const s = setup();
    await call(s.db, s.box, { action: 'delete', confirm: '注销' });
    s.box.length = 0;
    s.db.sessions.set('aaaaaaaa-s9', A);   // 冷静期里用邮箱验证码重新登录（新会话）
    return s;
  }

  it('TC-B1-100 ②：刚用验证码登录 → 恢复成功，pending 删掉、两列清空，发“已恢复”（无链接）', async () => {
    const { db, box, clock } = await pendingA();
    clock.advance(2 * DAY);
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(db.pending.has(A)).toBe(false);
    expect(db.profiles.get(A)).toMatchObject({ disabled_at: null, disabled_reason: null });
    expect(box.map((m) => m.mail.subject)).toEqual([restoredMail('zh-CN').subject]);
    expect(box[0]?.mail.text).not.toMatch(/http|www\./i);
  });

  it('TC-B1-100 ④：otp 超过 10 分钟回 reauth_required，仍在冷静期，不计次数', async () => {
    const { db, box, clock } = await pendingA();
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9', amr: [{ method: 'otp', timestamp: Math.floor(clock.ms / 1000) - 601 }] });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'reauth_required' });
    expect(db.pending.has(A)).toBe(true);
    expect([...db.counters.keys()].some((k) => k.startsWith('restore:'))).toBe(false);
  });

  it('TC-B1-100 ⑤：当天第 6 次被拒（每天 5 次）', async () => {
    const { db, box } = await pendingA();
    for (let i = 0; i < RESTORE_DAILY_LIMIT; i++) db.takeRate(keys.restore(A, db.clock.ms), RESTORE_DAILY_LIMIT, 86400);
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(db.pending.has(A)).toBe(true);
  });

  it('TC-B1-108 ①：account-purge 已认领（purge_started_at 不为空）→ restore_too_late；purge_after 已到也一样', async () => {
    const { db, box, clock } = await pendingA();
    const d = db.pending.get(A);
    if (!d) throw new Error('no pending');
    d.purge_started_at = new Date(clock.ms).toISOString();
    expect(await (await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' })).json()).toEqual({ error: 'restore_too_late' });
    d.purge_started_at = null;
    clock.advance(7 * DAY);
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'restore_too_late' });
    expect(db.pending.has(A)).toBe(true);
  });

  it('没申请注销的人调 restore：not_pending', async () => {
    const { db, box } = setup();
    const r = await call(db, box, { action: 'restore' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'not_pending' });
  });

  it('TC-B1-103 ②、104 ①：管理员停用的账号调 restore 回 account_disabled（requireActiveUser 拦下，rpc 那一道也拦）', async () => {
    const { db, box } = await pendingA();
    const p = db.profiles.get(A);
    if (!p) throw new Error('no profile');
    p.disabled_reason = 'admin';   // admin_set_disabled(A, true)
    const r = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'account_disabled' });
    expect(db.pending.has(A)).toBe(true);
    // 并发：鉴权时还是 deletion，进 rpc 前被管理员停用
    p.disabled_reason = 'deletion';
    const store = db.accountStore();
    const r2 = await call(db, box, { action: 'restore' }, { session: 'aaaaaaaa-s9', store: { ...store, restore: async (u) => { p.disabled_reason = 'admin'; return db.restore(u); } } });
    expect(await r2.json()).toEqual({ error: 'account_disabled' });
    expect(box).toEqual([]);
  });

  it('TC-B1-100 ⑧、99 ②：冷静期里 export 回 account_pending_deletion（只有 restore 放行），不写 logs', async () => {
    const { db, box } = await pendingA();
    const r = await call(db, box, { action: 'export', step: 'start' }, { session: 'aaaaaaaa-s9' });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'account_pending_deletion' });
    expect(db.logs).toEqual([]);
  });
});

describe('account 的错误码（0.38 第 48 条：shared/schema/account.ts 的 accountErrorCode，前后端共用）', () => {
  it('core.ts 的 13 个码（0.47 加 export_expired、export_too_large）和 shared/schema/account.ts 一字不差、顺序一致（架构第 6 节那张表的顺序）', () => {
    expect([...ACCOUNT_ERRS]).toEqual([...ACCOUNT_ERROR_CODES]);
    expect(ACCOUNT_ERROR_CODES).toHaveLength(13);
    for (const c of ACCOUNT_ERRS) expect(accountErrorCode.safeParse(c).success, c).toBe(true);
    expect(accountErrorCode.safeParse('bad_request').success).toBe(false);   // 各函数共用的码不在 account 的表里
  });

  it('各路径回的错误码都在表里（或是共用的 bad_request、method_not_allowed）', async () => {
    const seen = new Set<string>();
    const { db, box } = setup();
    const grab = async (r: Response) => { const b = (await r.json()) as { error?: string }; if (b.error) seen.add(b.error); };
    await grab(await call(db, box, { action: 'delete', confirm: 'x' }));
    await grab(await call(db, box, { action: 'restore' }));
    await grab(await call(db, box, { action: 'export', step: 'start' }, {}, { 'x-vault-token': 'tok' }));
    await grab(await call(db, box, { action: 'nope' }));
    db.admins.add(A);
    await grab(await call(db, box, { action: 'delete', confirm: '注销' }));
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const c of seen) expect(c === 'bad_request' || accountErrorCode.safeParse(c).success, c).toBe(true);
  });
});

describe('入口', () => {
  it('只收 POST；action 不认识、正文不是对象都回 bad_request', async () => {
    const { db, box } = setup();
    const deps = accountDeps(db, box);
    expect((await handle(new Request('https://x/account', { method: 'GET' }), deps)).status).toBe(405);
    for (const body of [null, [], 'x', { action: 'purge' }, { action: 1 }]) {
      expect((await handle(accountReq(body), deps)).status).toBe(400);
    }
  });

  it('TC-B1-65 ②：鉴权没过：原样回 requireActiveUser 的错误（会话被吊销的旧设备）', async () => {
    const { db, box } = setup();
    await call(db, box, { action: 'delete', confirm: '注销' });
    const r = await call(db, box, { action: 'restore' });   // 原来的会话 aaaaaaaa-s1 已吊销
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'session_revoked' });
  });
});

describe('注销相关邮件（TC-B1-107 ③：四封都不放链接，时刻按本人时区）', () => {
  it('中、韩两种语言的四封信正文都没有 http、www、域名', () => {
    for (const loc of ['zh-CN', 'ko-KR'] as const) {
      const mails = [deletionRequestedMail(loc, T0, 'Asia/Seoul'), deletionReminderMail(loc, T0, 'Asia/Shanghai'), deletionDoneMail(loc), restoredMail(loc),
        exportMail(loc, T0, 'Asia/Seoul', null, null)];
      for (const m of mails) {
        expect(m.text, `${loc} ${m.subject}`).not.toMatch(/https?:|www\.|\.com|\.co\b|<a\s/i);
        expect(m.subject.length).toBeGreaterThan(0);
      }
    }
  });

  it('时刻按时区换算；时区名不对就按首尔', () => {
    expect(fmtWhen(T0, 'Asia/Shanghai', 'zh-CN')).toBe('2026年10月29日 11:00（Asia/Shanghai）');
    expect(fmtWhen(T0 + 13 * H, 'Asia/Seoul', 'ko-KR')).toBe('2026년 10월 30일 01:00 (Asia/Seoul)');
    expect(safeTz('Not/AZone')).toBe('Asia/Seoul');
    expect(safeTz(null)).toBe('Asia/Seoul');
    expect(fmtWhen(T0, 'Not/AZone', 'zh-CN')).toBe('2026年10月29日 12:00（Asia/Seoul）');
  });

  it('申请信写“恢复账号”和“留意垃圾邮件”（15.7 第 8 项）；提醒信写“恢复账号”', () => {
    expect(deletionRequestedMail('zh-CN', T0, 'Asia/Seoul').text).toMatch(/恢复账号[\s\S]*垃圾邮件/);
    expect(deletionReminderMail('zh-CN', T0, 'Asia/Seoul').text).toContain('恢复账号');
    expect(deletionReminderMail('ko-KR', T0, 'Asia/Seoul').text).toContain('계정 복구');
  });
});
