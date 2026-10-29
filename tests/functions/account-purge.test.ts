// account-purge 的单元测试（B1 K3；架构第 6 节“account-purge 怎么执行”，0.38 第 24 条 S9；0.29 续第 131、137、138、143 条）：
// TC-B1-97 ②（级联不写墓碑见 10_account_cascade.test.sql）、101、102 ①②、104 ④、107 ①②③、108 ①③④、TC-B0-117。
// 只测 core.ts（index.ts 只是把 supabase-js、R2、Storage、Resend 接上）；数据库由 tests/functions/account-fakes.ts 的内存版代替。
import { describe, expect, it } from 'vitest';
import { CLAIM_STALE_MS, handle, PURGE_TIME_BUDGET_MS, R2_BUCKETS } from '../../supabase/functions/account-purge/core.ts';
import { handle as accountHandle } from '../../supabase/functions/account/core.ts';
import { emailHash } from '../../supabase/functions/_shared/email-hash.ts';
import { deletionDoneMail, deletionReminderMail, deletionRequestedMail, restoredMail } from '../../supabase/functions/_shared/account-mail.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { MemoryObjStore } from '../fakes/objstore-memory.ts';
import { putSeedObjects, SEED_USERS, seedObjects } from '../fakes/objstore-seed.ts';
import { generate } from '../data-manifest/generate.ts';
import { purgeCases, runPurgeCases, type PurgeActs } from '../data-manifest/purge-runner.ts';
import {
  A, accountDeps, accountReq, B, C, Clock, CRON, cronReq, DAY, FakeBackups, FakeDb, H, HASH_SECRET, type Outbox, purgeDeps, T0,
} from './account-fakes.ts';

function world() {
  const clock = new Clock();
  const db = new FakeDb(clock);
  db.addUser(A, 'A@Test.local');
  db.addUser(B, 'b@test.local', { ui_locale: 'ko-KR' });
  const r2 = new MemoryObjStore(R2_BUCKETS);
  const backups = new FakeBackups();
  const box: Outbox[] = [];
  return { clock, db, r2, backups, box };
}

type World = ReturnType<typeof world>;

async function requestDeletion(w: World, uid: string) {
  const deps = accountDeps(w.db, w.box, { user: uid });
  const r = await accountHandle(accountReq({ action: 'delete', confirm: '注销' }), deps);
  await Promise.all(deps.bg);
  expect(r.status).toBe(200);
}

async function runPurge(w: World, over: Parameters<typeof purgeDeps>[4] = {}) {
  const deps = purgeDeps(w.db, w.r2, w.backups, w.box, over);
  const res = await handle(cronReq(), deps);
  return { res, body: (await res.json()) as Record<string, unknown>, logs: deps.logs };
}

/** 两个人的库外数据：四个 R2 桶（seed）、两个日期的服务器备份 */
async function seedOutside(w: World) {
  await putSeedObjects(w.r2);
  for (const d of ['20261101', '20261102']) for (const u of [A, B]) for (const t of ['notes', 'todos']) w.backups.files.add(`${d}/${u}/${t}.json.gz`);
}

/** 到“满 7 天后的第一次 03:30（首尔）”：申请在 10-29 12:00（首尔），+7 天是 11-05 12:00，下一次 03:30 是 11-06 03:30 = UTC 11-05 18:30 */
const FIRST_RUN_AFTER = Date.parse('2026-11-05T18:30:00Z');

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

describe('时间预算、backups 子目录（K3 安全审查低 9、10）', () => {
  it('处理完一个账号时间就用完：不再认领下一个（deferred），下一次运行再做', async () => {
    const w = world();
    await requestDeletion(w, A);
    await requestDeletion(w, B);
    w.clock.ms = FIRST_RUN_AFTER;
    const r = await runPurge(w, {
      deleteUser: async (u) => { w.db.deleteUserCascade(u); w.clock.advance(PURGE_TIME_BUDGET_MS); },
    });
    expect(r.body).toMatchObject({ purged: 1, deferred: 1, failed: 0 });
    expect(r.logs).toContain('time_budget_deferred:1');
    const left = w.db.users.has(A) ? A : B;
    expect(w.db.pending.get(left)?.purge_started_at).toBeNull();   // 没认领
    expect(w.db.heartbeat).toMatchObject({ purged: 1, deferred: 1 });
    w.clock.advance(DAY);
    expect((await runPurge(w)).body).toMatchObject({ purged: 1, deferred: 0 });
    expect(w.db.users.has(left)).toBe(false);
  });

  it('做到一半时间用完：在写 deleted_accounts 之前停下、清掉认领，账号还在', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    const r = await runPurge(w, {
      userEmail: async (u) => { w.clock.advance(PURGE_TIME_BUDGET_MS); return w.db.users.get(u) ?? null; },
    });
    expect(r.body).toMatchObject({ purged: 0, deferred: 1, failed: 0 });
    expect(r.logs).toContain('time_budget:aaaaaaaa');
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.db.pending.get(A)?.purge_started_at).toBeNull();
  });

  it('backups 的 <日期>/<user_id>/ 下有子目录：整个账号报错停下、清掉认领（删不到的不当作删完）', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.backups.files.add(`20261101/${A}/notes.json.gz`);
    w.backups.files.add(`20261101/${A}/old/notes.json.gz`);
    w.clock.ms = FIRST_RUN_AFTER;
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ purged: 0, failed: 1 });
    expect(r.logs).toContain('backups_subdir:aaaaaaaa');
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.db.pending.get(A)?.purge_started_at).toBeNull();
  });
});

describe('TC-B1-108：和 restore 不撞车', () => {
  it('① 已认领（另一次正在做，不到 1 小时）：这一次认领不到、跳过；restore 也被拒', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    const d = w.db.pending.get(A);
    if (!d) throw new Error('no pending');
    d.purge_started_at = new Date(w.clock.ms - CLAIM_STALE_MS + 60_000).toISOString();   // 59 分钟前认领
    expect((await runPurge(w)).body).toMatchObject({ purged: 0, skipped: 0 });   // 不在候选里
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.restore(A)).toBe('purge_started');
  });

  it('③ 认领了没删完（进程崩了、认领没清掉）：59 分钟认领不到，61 分钟能重领并完成（0.38 第 44 条）', async () => {
    expect(CLAIM_STALE_MS).toBe(60 * 60_000);
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    const d = w.db.pending.get(A);
    if (!d) throw new Error('no pending');
    const crashedAt = w.clock.ms;
    d.purge_started_at = new Date(crashedAt).toISOString();
    w.clock.ms = crashedAt + 59 * 60_000;
    expect((await runPurge(w)).body).toMatchObject({ purged: 0, skipped: 0 });
    expect(w.db.pending.get(A)?.purge_started_at).toBe(new Date(crashedAt).toISOString());
    w.clock.ms = crashedAt + 61 * 60_000;
    expect((await runPurge(w)).body).toMatchObject({ purged: 1 });
    expect(w.db.users.has(A)).toBe(false);
  });

  it('④ 走到写 deleted_accounts 前这一行被删了（restore 等）：不写 deleted_accounts、不删账号', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = FIRST_RUN_AFTER;
    w.db.beforeStillClaimed = () => { w.db.pending.delete(A); };
    const r = await runPurge(w);
    expect(r.logs).toContain('skip_claim_gone:aaaaaaaa');
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.db.users.has(A)).toBe(true);
  });

  it('② restore 先完成（这一行已不在）：认领不到，不删 A', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.clock.ms = T0 + 7 * DAY - 3 * H;   // 到期前 3 小时恢复
    expect(w.db.restore(A)).toBe('ok');
    w.clock.ms = FIRST_RUN_AFTER;
    expect((await runPurge(w)).body).toMatchObject({ purged: 0 });
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.profiles.get(A)?.disabled_at).toBeNull();
  });
});

describe('TC-B1-107：到期前提醒', () => {
  const RUN = (day: number) => Date.parse('2026-10-29T18:30:00Z') + day * DAY;   // 第 day 天 03:30（首尔）

  it('① A 在 purge_after 前 48 小时以内的第一次运行收到提醒，notice_sent 变 true，之后不再发', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.box.length = 0;
    const got: number[] = [];
    for (let d = 1; d <= 6; d++) {
      w.clock.ms = RUN(d);
      const before = w.box.length;
      await runPurge(w);
      if (w.box.length > before) got.push(d);
    }
    expect(got).toEqual([5]);   // 11-04 03:30 距 11-05 12:00 是 32.5 小时
    expect(w.db.pending.get(A)?.notice_sent).toBe(true);
    expect(w.box[0]?.mail.text).toContain('2026年11月5日 12:00（Asia/Seoul）');
    expect(w.box[0]?.mail.text).not.toMatch(/http/);
  });

  it('② B 在第 5 天那次漏跑，第 6 天补发一次（还没到期）', async () => {
    const w = world();
    await requestDeletion(w, B);
    w.box.length = 0;
    for (const d of [1, 2, 3, 4, 6]) { w.clock.ms = RUN(d); await runPurge(w); }
    expect(w.box).toHaveLength(1);
    expect(w.box[0]?.mail.text).toContain('2026년 11월 5일 12:00 (Asia/Seoul)');
  });

  it('先发信、发成功再标 notice_sent（K3 安全审查低 11）：发的那一刻还是 false', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.box.length = 0;
    w.clock.ms = RUN(5);
    const seen: (boolean | undefined)[] = [];
    await runPurge(w, { sendMail: async (to, mail) => { seen.push(w.db.pending.get(A)?.notice_sent); w.box.push({ to, mail }); return true; } });
    expect(seen).toEqual([false]);
    expect(w.db.pending.get(A)?.notice_sent).toBe(true);
  });

  it('发成功、标记出错：这次算发了，下一次运行会再发一封（选先发的代价，文件头写明）', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.box.length = 0;
    w.clock.ms = RUN(5);
    w.db.fail.add('casNotice');
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ sent: 1 });
    expect(r.logs).toContain('remind_failed:aaaaaaaa');
    w.db.fail.delete('casNotice');
    w.clock.ms = RUN(5) + 6 * H;
    await runPurge(w);
    expect(w.box).toHaveLength(2);
    expect(w.db.pending.get(A)?.notice_sent).toBe(true);
  });

  it('发信失败：notice_sent 不动（还是 false），下一次运行补发', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.box.length = 0;
    w.clock.ms = RUN(5);
    await runPurge(w, { sendMail: async () => false });
    expect(w.db.pending.get(A)?.notice_sent).toBe(false);
    w.clock.ms = RUN(5) + 6 * H;
    await runPurge(w);
    expect(w.box).toHaveLength(1);
    expect(w.db.pending.get(A)?.notice_sent).toBe(true);
  });

  it('③ 另一个账号申请后恢复：收到“已恢复”，四封信正文都没有 http', async () => {
    const w = world();
    await requestDeletion(w, B);
    const deps = accountDeps(w.db, w.box, { user: B, session: 'bbbbbbbb-s9' });
    w.db.sessions.set('bbbbbbbb-s9', B);
    await accountHandle(accountReq({ action: 'restore' }), deps);
    await Promise.all(deps.bg);
    expect(w.box.map((m) => m.mail.subject)).toEqual([deletionRequestedMail('ko-KR', 0, 'Asia/Seoul').subject, restoredMail('ko-KR').subject]);
    for (const m of w.box) expect(m.mail.text).not.toMatch(/http/);
  });
});

// TC-B0-117（架构 0.33 第 1 条从 B0 挪到 B1）：生成器产出的四个 R2 桶注销用例（对象存储探针按 userLookup 列前缀、数个数），
// account-delete、account-purge 用这一批真的 core.ts（不是 purge-runner.ts 里的 memoryPurgeActs 替身），打内存 S3 替身。
// 真 R2（预览环境）那一遍是任务单第五节第 9 项的后一半，要部署后在预览上做。
describe('TC-B0-117：四个 R2 桶，A 申请注销 → 满 7 天跑 account-purge → A 的前缀为 0、B 不变、删完又列了一次', () => {
  it('生成的探针用例全过（冷静期里一个都不少；purge 后 A 为 0、B 不变）', async () => {
    const cases = purgeCases(generate(allManifests).cases);
    expect(cases.map((c) => c.id).sort()).toEqual(R2_BUCKETS.map((b) => `TC-DEL-bucket-${b}`).sort());
    const w = world();
    const acts: PurgeActs = {
      accountDelete: async (u) => {
        if (!w.db.users.has(u)) w.db.addUser(u, `${u.slice(0, 8)}@test.local`);
        await requestDeletion(w, u);
      },
      accountPurge: async () => {
        w.clock.advance(7 * DAY + H);
        const { body } = await runPurge(w);
        expect(body).toMatchObject({ failed: 0 });
      },
    };
    expect(SEED_USERS.a).toBe(A);
    const out = await runPurgeCases(cases, { store: w.r2, acts });
    for (const o of out) expect(o.problems, o.id).toEqual([]);
    for (const b of R2_BUCKETS) {
      expect(w.r2.count(b, `${A}/`), b).toBe(0);
      expect(w.r2.count(b, `${B}/`), b).toBe(seedObjects().filter((o) => o.bucket === b && o.owner === 'b').length);
      // 删完又列了一次：每个桶 deleteMany 之后还有一次 list
      const ops = w.r2.calls.filter((c) => c.bucket === b).map((c) => c.op);
      const lastDelete = ops.lastIndexOf('deleteMany');
      expect(lastDelete, b).toBeGreaterThanOrEqual(0);
      expect(ops.slice(lastDelete + 1), b).toContain('list');
    }
    expect(w.db.users.has(A)).toBe(false);
    expect(w.db.deleted.has(A)).toBe(true);
  });
});
