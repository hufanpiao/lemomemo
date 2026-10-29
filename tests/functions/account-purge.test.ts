// account-purge 的单元测试（B1 K3；架构第 6 节“account-purge 怎么执行”，0.38 第 24 条 S9；0.29 续第 131、137、138、143 条）：
// TC-B1-97 ②（级联不写墓碑见 10_account_cascade.test.sql）、101、102 ①②、104 ④、107 ①②③、108 ①③④、TC-B0-117。
// 只测 core.ts（index.ts 只是把 supabase-js、R2、Storage、Resend 接上）；数据库由 tests/functions/account-fakes.ts 的内存版代替。
// 这一份：鉴权、TC-B1-101、102；时间预算、TC-B1-108、107、TC-B0-117 在 account-purge-schedule.test.ts（B1 第九批按主题拆开），
// 共用的 world、requestDeletion、runPurge 在 account-purge-harness.ts。
import { describe, expect, it } from 'vitest';
import { handle, R2_BUCKETS } from '../../supabase/functions/account-purge/core.ts';
import { emailHash } from '../../supabase/functions/_shared/email-hash.ts';
import { deletionDoneMail, deletionReminderMail, deletionRequestedMail } from '../../supabase/functions/_shared/account-mail.ts';
import { seedObjects } from '../fakes/objstore-seed.ts';
import { A, B, C, CRON, cronReq, DAY, HASH_SECRET, purgeDeps } from './account-fakes.ts';
import { world, requestDeletion, runPurge, seedOutside, FIRST_RUN_AFTER } from './account-purge-harness.ts';

describe('鉴权', () => {
  it('TC-B1-101 ②：不带或带错 x-cron-secret 回 401，什么都不做', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    for (const s of [null, '', 'wrong', `${CRON}x`]) {
      const res = await handle(cronReq(s), purgeDeps(w.db, w.r2, w.backups, w.box));
      expect(res.status).toBe(401);
    }
    expect(w.db.pending.get(A)?.purge_started_at).toBeNull();
    expect(w.db.users.has(A)).toBe(true);
  });

  it('没配 CRON_SECRET 谁都 401；secret 少于 32 字节或缺依赖：带对了也回 500 misconfigured', async () => {
    const w = world();
    expect((await handle(cronReq(CRON), purgeDeps(w.db, w.r2, w.backups, w.box, { cronSecret: undefined }))).status).toBe(401);
    const short = 'x'.repeat(31);
    expect((await handle(cronReq(short), purgeDeps(w.db, w.r2, w.backups, w.box, { cronSecret: short }))).status).toBe(500);
    expect((await handle(cronReq(CRON), purgeDeps(w.db, w.r2, w.backups, w.box, { r2: null }))).status).toBe(500);
    expect((await handle(new Request('https://x/account-purge', { method: 'GET', headers: { 'x-cron-secret': CRON } }), purgeDeps(w.db, w.r2, w.backups, w.box))).status).toBe(405);
  });
});

describe('TC-B1-101：满 7 天后彻底删除', () => {
  it('冷静期里不动；到期后按顺序删 R2 → 备份 → 邮箱哈希 → counters → deleted_accounts → deleteUser，发最后一封信，写心跳；B 一条不少', async () => {
    const w = world();
    await seedOutside(w);
    const eh = await emailHash(HASH_SECRET, 'a@test.local');
    w.db.pendingSignups.add(eh);
    w.db.counters.set(`signup-mail:mail:${eh}|1`, 2);
    w.db.counters.set(`ai:${A}:20261029|1`, 3);
    w.db.counters.set(`tzphone:${A}:last|1`, 1);
    w.db.counters.set(`ai:${B}:20261029|1`, 4);
    w.db.counters.set('signup-ip:ip:abc|1', 1);
    await requestDeletion(w, A);

    // 冷静期第 6 天：什么都不删（TC-B1-99 ⑦：counters 里 A 的键保留）
    w.clock.ms = FIRST_RUN_AFTER - 2 * DAY;
    const mid = await runPurge(w);
    expect(mid.body).toMatchObject({ ok: true, purged: 0 });
    expect(w.db.users.has(A)).toBe(true);
    expect(w.r2.count('images', `${A}/`)).toBeGreaterThan(0);
    expect(w.backups.count(A)).toBe(4);
    expect(w.db.deleted.size).toBe(0);
    expect([...w.db.counters.keys()].some((k) => k.includes(A))).toBe(true);

    w.clock.ms = FIRST_RUN_AFTER;
    w.box.length = 0;
    const calls0 = w.r2.calls.length;
    const { body } = await runPurge(w);
    expect(body).toMatchObject({ ok: true, purged: 1, failed: 0 });
    // R2 四个桶：A 为 0、B 不变；每个桶都“列 → 删 → 再列一次”
    for (const b of R2_BUCKETS) {
      expect(w.r2.count(b, `${A}/`), b).toBe(0);
      expect(w.r2.count(b, `${B}/`), b).toBe(seedObjects().filter((o) => o.bucket === b && o.owner === 'b').length);
      const ops = w.r2.calls.slice(calls0).filter((c) => c.bucket === b).map((c) => c.op);
      expect(ops.filter((o) => o === 'list').length, b).toBeGreaterThanOrEqual(2);
    }
    // 备份：两个日期都删光，B 的不动
    expect(w.backups.count(A)).toBe(0);
    expect(w.backups.count(B)).toBe(4);
    // 邮箱哈希两样（邮箱按小写算，和 invite-signup 同一个函数）
    expect(w.db.pendingSignups.has(eh)).toBe(false);
    expect([...w.db.counters.keys()].some((k) => k.startsWith(`signup-mail:mail:${eh}`))).toBe(false);
    // counters：A 的全删，B 的、IP 的留着
    expect([...w.db.counters.keys()].some((k) => k.includes(A))).toBe(false);
    expect(w.db.counters.has(`ai:${B}:20261029|1`)).toBe(true);
    expect(w.db.counters.has('signup-ip:ip:abc|1')).toBe(true);
    // deleted_accounts 写了，账号和 pending_deletions、profiles、revoked_sessions 都没了
    expect(w.db.deleted.has(A)).toBe(true);
    expect(w.db.users.has(A)).toBe(false);
    expect(w.db.pending.has(A)).toBe(false);
    expect(w.db.profiles.has(A)).toBe(false);
    expect([...w.db.revoked.values()]).not.toContain(A);
    expect(w.db.users.has(B)).toBe(true);
    // 最后一封信发到删之前取出的邮箱
    expect(w.box.map((m) => [m.to, m.mail.subject])).toEqual([['A@Test.local', deletionDoneMail('zh-CN').subject]]);
    // 心跳
    expect(w.db.heartbeat).toMatchObject({ purged: 1, failed: 0 });
  });

  it('A 一共收三封：申请、到期前提醒、彻底删除（TC-B1-101 ①、107 ③）', async () => {
    const w = world();
    await requestDeletion(w, A);
    for (let d = 1; d <= 7; d++) {
      w.clock.ms = Date.parse('2026-10-29T18:30:00Z') + d * DAY;   // 每天 03:30（首尔）
      await runPurge(w);
    }
    expect(w.box.map((m) => m.mail.subject)).toEqual([
      deletionRequestedMail('zh-CN', 0, 'Asia/Seoul').subject,
      deletionReminderMail('zh-CN', 0, 'Asia/Seoul').subject,
      deletionDoneMail('zh-CN').subject,
    ]);
    for (const m of w.box) expect(m.mail.text).not.toMatch(/http/);
  });

  it('SIGNUP_HASH_SECRET 换过（或没配）：pending_signups、signup-mail 删不到，注销照样做完', async () => {
    for (const hashSecret of ['rotated-secret', undefined]) {
      const w = world();
      const eh = await emailHash(HASH_SECRET, 'a@test.local');
      w.db.pendingSignups.add(eh);
      await requestDeletion(w, A);
      w.clock.ms = FIRST_RUN_AFTER;
      const { body, logs } = await runPurge(w, { hashSecret });
      expect(body).toMatchObject({ purged: 1, failed: 0 });
      expect(w.db.users.has(A)).toBe(false);
      expect(w.db.pendingSignups.has(eh)).toBe(true);   // 10 分钟就过期的东西，由每日清理删
      if (hashSecret === undefined) expect(logs).toContain('hash_secret_missing:aaaaaaaa');
    }
  });

  it('TC-B1-104 ④：冷静期里被管理员停用（disabled_reason = admin）照样删', async () => {
    const w = world();
    await requestDeletion(w, A);
    const p = w.db.profiles.get(A);
    if (p) p.disabled_reason = 'admin';
    w.clock.ms = FIRST_RUN_AFTER;
    expect((await runPurge(w)).body).toMatchObject({ purged: 1 });
    expect(w.db.users.has(A)).toBe(false);
  });

  it('认领后再核对：在 admins 里、或 profile 没停用（不一致）→ 清掉认领、跳过，不删', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.db.admins.add(A);
    w.clock.ms = FIRST_RUN_AFTER;
    const r1 = await runPurge(w);
    expect(r1.body).toMatchObject({ purged: 0, failed: 0, skipped: 1 });
    expect(r1.logs).toContain('skip_admin:aaaaaaaa');
    expect(w.db.pending.get(A)?.purge_started_at).toBeNull();
    expect(w.db.users.has(A)).toBe(true);
    w.db.admins.delete(A);
    const p = w.db.profiles.get(A);
    if (p) { p.disabled_at = null; p.disabled_reason = null; }
    const r2 = await runPurge(w);
    expect(r2.logs).toContain('skip_not_disabled:aaaaaaaa');
    expect(w.db.users.has(A)).toBe(true);
  });
});

describe('TC-B1-102：一个失败不影响别人，第二天重试', () => {
  it('A 的 R2 删除失败 → A 停下（pending 还在、没写 deleted_accounts、认领清掉），C 照常删；第二天 A 重试成功', async () => {
    const w = world();
    w.db.addUser(C, 'c@test.local');
    await seedOutside(w);
    await requestDeletion(w, A);
    await requestDeletion(w, C);
    w.clock.ms = FIRST_RUN_AFTER;
    w.r2.failOnce('deleteMany');   // A 排在前面（purge_after 一样时按插入顺序），第一个 deleteMany 就是 A 的
    const day1 = await runPurge(w);
    expect(day1.body).toMatchObject({ purged: 1, failed: 1 });
    expect(day1.logs.some((l) => l.endsWith(':aaaaaaaa'))).toBe(true);
    expect(w.db.pending.get(A)).toMatchObject({ purge_started_at: null });
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.users.has(C)).toBe(false);
    expect(w.db.heartbeat).toMatchObject({ purged: 1, failed: 1 });

    w.clock.advance(DAY);
    const day2 = await runPurge(w);
    expect(day2.body).toMatchObject({ purged: 1, failed: 0 });
    expect(w.db.users.has(A)).toBe(false);
    for (const b of R2_BUCKETS) expect(w.r2.count(b, `${A}/`)).toBe(0);
  });

  it('R2 删完再列不为 0（not_empty）、备份删完再列不为 0：都不往下走（数据库还在、不写 deleted_accounts）', async () => {
    const w = world();
    await seedOutside(w);
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    const failing = { deletePrefix: async () => { throw Object.assign(new Error('objstore_not_empty'), { code: 'not_empty' }); } };
    const r1 = await runPurge(w, { r2: failing });
    expect(r1.logs).toContain('r2_not_empty:aaaaaaaa');
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.db.users.has(A)).toBe(true);
    expect(w.backups.count(A)).toBe(4);   // R2 没删完，备份也不动

    w.backups.removeKeepsOne = true;
    const r2 = await runPurge(w);
    expect(r2.logs).toContain('backups_not_empty:aaaaaaaa');
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.db.users.has(A)).toBe(true);
  });

  it('deleteUser 失败：deleted_accounts 已写；第二天重来照样完成（写入 on conflict do nothing）', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    w.db.fail.add('deleteUser');
    expect((await runPurge(w)).body).toMatchObject({ failed: 1 });
    expect(w.db.deleted.has(A)).toBe(true);
    expect(w.db.users.has(A)).toBe(true);
    w.db.fail.delete('deleteUser');
    w.clock.advance(DAY);
    expect((await runPurge(w)).body).toMatchObject({ purged: 1 });
    expect(w.db.users.has(A)).toBe(false);
  });

  it('查到期名单就出错：503，不写心跳（lemo-ops 靠 26 小时没心跳告警）', async () => {
    const w = world();
    w.db.fail.add('listDue');
    const { res } = await runPurge(w);
    expect(res.status).toBe(503);
    expect(w.db.heartbeat).toBeNull();
  });

  it('deleteUser 以后核对 profiles、pending_deletions 不是 0 行：算失败（告警）', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    const r = await runPurge(w, { deleteUser: async () => { w.db.users.delete(A); } });   // 假装删了、其实没级联
    expect(r.body).toMatchObject({ purged: 0, failed: 1 });
    expect(r.logs).toContain('verify_failed:aaaaaaaa');
  });
});
