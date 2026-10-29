// account-purge 的单元测试（续，B1 第九批从 account-purge.test.ts 拆出）：时间预算和 backups 子目录（K3 安全审查低 9、10）、
// TC-B1-108 和 restore 不撞车、TC-B1-107 到期前提醒、TC-B0-117 四个 R2 桶。共用的准备代码在 account-purge-harness.ts。
import { describe, expect, it } from 'vitest';
import { CLAIM_STALE_MS, PURGE_TIME_BUDGET_MS, R2_BUCKETS } from '../../supabase/functions/account-purge/core.ts';
import { handle as accountHandle } from '../../supabase/functions/account/core.ts';
import { deletionRequestedMail, restoredMail } from '../../supabase/functions/_shared/account-mail.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { SEED_USERS, seedObjects } from '../fakes/objstore-seed.ts';
import { generate } from '../data-manifest/generate.ts';
import { purgeCases, runPurgeCases, type PurgeActs } from '../data-manifest/purge-runner.ts';
import { A, accountDeps, accountReq, B, DAY, H, T0 } from './account-fakes.ts';
import { world, requestDeletion, runPurge, FIRST_RUN_AFTER } from './account-purge-harness.ts';

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
