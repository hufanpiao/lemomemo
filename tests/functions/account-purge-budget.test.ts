// account-purge 删除段的预算（PURGE-cpu-budget，11-04；B1 代码审查高 1、中 1、低 1、低 3 返工）：
//   • 每次调用 CPU 硬上限 2 秒，按“调用次数”估：两段各用各的上限（REMIND_WORK_OPS、PURGE_WORK_OPS），另有 110 秒墙钟兜底；
//   • 删除段用完上限就不再认领新账号；正在做的账号只在“真删了东西”的检查点停下、放回认领，下一次运行接着删；
//   • 提醒段、补发并顺延在 account-purge-remind.test.ts；不可逆步骤前的 110 秒保护（中 2）在 account-purge-schedule.test.ts。
// 调用次数怎么数见 core.ts 的 countedDeps；这里用“R2 某个桶一次删了很多对象”把次数一下子顶上去，
// 或者铺很多备份日期（每个日期 列、删、再列 3 次），不依赖墙钟。
import { describe, expect, it } from 'vitest';
import { PURGE_WORK_OPS, R2_BUCKETS, type R2 } from '../../supabase/functions/account-purge/core.ts';
import { A, B, type FakeBackups } from './account-fakes.ts';
import { requestDeletion, runPurge, toFirstRun, world, type World } from './account-purge-harness.ts';

const MIN = 60_000;
/** 一次删掉这么多对象，折算的调用次数就超过删除段的上限（列、删、再列：2 × 页数 + 删的次数） */
const HUGE = PURGE_WORK_OPS * 1000;

/** 真 R2 照删，另外让某一个桶报“删了 HUGE 个”（把调用次数顶过上限） */
function heavyR2(w: World, bucket: string): R2 & { calls: string[] } {
  const real = w.r2;
  const calls: string[] = [];
  return {
    calls,
    async deletePrefix(b, p) {
      calls.push(b);
      const r = await real.deletePrefix(b, p);
      return b === bucket ? { deleted: HUGE } : r;
    },
  };
}

const day = (i: number) => `2026${String(1001 + i).padStart(4, '0')}`;

/** A 在 n 个日期里各有一个备份文件；B 在同样的日期里也各有一个（对照） */
function seedDates(backups: FakeBackups, n: number, from = 0) {
  for (let i = from; i < n; i++) {
    backups.files.add(`${day(i)}/${A}/notes.json.gz`);
    backups.files.add(`${day(i)}/${B}/notes.json.gz`);
  }
}

describe('删除段：按调用次数停手，不再领新账号，心跳带 remaining', () => {
  it('做完 A 时调用次数用完：B 不认领（deferred），心跳 remaining 1；15 分钟后的补跑接着做完 B', async () => {
    const w = world();
    await requestDeletion(w, A);
    await requestDeletion(w, B);
    toFirstRun(w);
    // 最后一个桶不是检查点（交给备份段），A 没有备份：A 走完，之后不再认领 B
    const r = await runPurge(w, { r2: heavyR2(w, R2_BUCKETS[R2_BUCKETS.length - 1] ?? '') });
    expect(r.body).toMatchObject({ purged: 1, deferred: 1, failed: 0, held: 0, remaining: 1 });
    expect(Number(r.body['ops'])).toBeGreaterThanOrEqual(PURGE_WORK_OPS);
    expect(w.db.heartbeat).toMatchObject({ purged: 1, deferred: 1, remaining: 1 });
    const left = w.db.users.has(A) ? A : B;
    expect(w.db.pending.get(left)?.purge_started_at).toBeNull();
    w.clock.advance(15 * MIN);
    expect((await runPurge(w)).body).toMatchObject({ purged: 1, deferred: 0, remaining: 0 });
    expect(w.db.users.has(left)).toBe(false);
  });

  it('remaining = deferred + failed + held，口径写在 core.ts；心跳只有这些数字键', async () => {
    const w = world();
    await requestDeletion(w, A);
    await requestDeletion(w, B);
    toFirstRun(w);
    w.db.fail.add('deleteUser');
    const pb = w.db.pending.get(B);
    if (pb) pb.notice_sent = false;   // B 没提醒过：这一轮补发（顺延），不删
    const r = await runPurge(w, { sendMail: async () => false });   // 补发也失败：B 留着（held）
    expect(r.body).toMatchObject({ purged: 0, failed: 1, held: 1, deferred: 0, remaining: 2 });
    expect(r.logs).toContain(`purge_held_no_notice:${B.slice(0, 8)}`);
    expect(Object.keys(w.db.heartbeat ?? {}).sort()).toEqual(
      ['blocked', 'deferred', 'failed', 'forced', 'held', 'ms', 'ops', 'postponed', 'purged', 'remaining', 'remind_left', 'remind_ops', 'sent']);
    for (const v of Object.values(w.db.heartbeat ?? {})) expect(typeof v).toBe('number');
  });
});

describe('删除段：半截续删，只在真删了东西之后停', () => {
  it('R2 检查点：第一个桶删了对象就超上限 → 停下、放回认领，账号和备份都还在；15 分钟后接着做完', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.backups.files.add(`20261101/${A}/notes.json.gz`);
    toFirstRun(w);
    const r2 = heavyR2(w, R2_BUCKETS[0]);
    const r = await runPurge(w, { r2 });
    expect(r2.calls).toEqual([R2_BUCKETS[0]]);
    expect(r.body).toMatchObject({ purged: 0, deferred: 1, failed: 0, remaining: 1 });
    expect(r.logs).toContain(`time_budget:${A.slice(0, 8)}`);
    expect(w.db.pending.get(A)?.purge_started_at).toBeNull();
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.backups.count(A)).toBe(1);
    w.clock.advance(15 * MIN);
    expect((await runPurge(w)).body).toMatchObject({ purged: 1, remaining: 0 });
    expect(w.db.users.has(A)).toBe(false);
  });

  it('空桶不是检查点（低 3）：R2 全空、备份也没有，次数超了也走完；最后一个桶删了很多也不停', async () => {
    const w = world();
    await requestDeletion(w, A);
    toFirstRun(w);
    const r = await runPurge(w, { r2: heavyR2(w, R2_BUCKETS[R2_BUCKETS.length - 1] ?? '') });
    expect(r.body).toMatchObject({ purged: 1, deferred: 0, remaining: 0 });
    expect(w.db.users.has(A)).toBe(false);
  });

  it('空桶不是检查点（复审低 C）：第一个桶是空的、列完时预算已经过了 → 不在空桶上停，四个桶都列、备份也删了，停在不可逆步骤前的 110 秒保护', async () => {
    const w = world();
    await requestDeletion(w, A);
    w.backups.files.add(`20261101/${A}/notes.json.gz`);
    toFirstRun(w);
    const real = w.r2;
    const calls: string[] = [];
    // 四个桶都是空的；列第一个桶花了 111 秒（预算从这里起就过了：overBudget 含墙钟）
    const r2: R2 = { async deletePrefix(b, p) { calls.push(b); const r = await real.deletePrefix(b, p); if (b === R2_BUCKETS[0]) w.clock.advance(111_000); return r; } };
    const r = await runPurge(w, { r2 });
    expect(calls).toEqual([...R2_BUCKETS]);
    expect(w.backups.count(A)).toBe(0);   // 唯一的日期也是最后一个日期：做完不停，一直走到第 5 步之后的墙钟检查
    expect(r.body).toMatchObject({ purged: 0, deferred: 1, remaining: 1 });
    expect(r.logs).toContain(`time_budget:${A.slice(0, 8)}`);
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.deleted.has(A)).toBe(false);
    expect(w.db.pending.get(A)?.purge_started_at).toBeNull();
    w.clock.advance(15 * MIN);
    expect((await runPurge(w)).body).toMatchObject({ purged: 1, remaining: 0 });
    expect(w.db.users.has(A)).toBe(false);
  });

  it('400 个备份日期：分几轮删完，每一轮剩下的严格变少、都写心跳、都放回认领，B 的备份一个不少', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 400);
    toFirstRun(w);
    const left: number[] = [];
    for (let i = 0; i < 200 && w.db.users.has(A); i++) {
      w.db.heartbeat = null;
      const r = await runPurge(w);
      left.push(w.backups.count(A));
      expect(w.db.heartbeat, `第 ${i + 1} 轮`).not.toBeNull();
      if (w.db.users.has(A)) {
        expect(w.db.pending.get(A)?.purge_started_at).toBeNull();
        // 过了上限、删掉下一个日期就停（每个日期最多 3 次）；第 2 轮起多出“前几轮删空的日期各列一次”（不在空日期上停，中 1）
        expect(Number(r.body['ops']), `第 ${i + 1} 轮`).toBeLessThan(PURGE_WORK_OPS + 5 + (i === 0 ? 0 : 400));
      }
      w.clock.advance(15 * MIN);
    }
    // 400 个日期是极端情况（服务器备份按 7 天轮换）：后面几轮光列已删空的日期就超上限，每轮只删一个日期，轮数会多（见执行记录）
    expect(left.length).toBeGreaterThanOrEqual(3);
    expect(left.length).toBeLessThanOrEqual(30);   // 上限 400 次时实测 28 轮（执行记录）
    for (let i = 1; i < left.length; i++) expect(left[i], `第 ${i + 1} 轮`).toBeLessThan(left[i - 1] ?? 0);
    expect(left.at(-1)).toBe(0);
    expect(w.db.deleted.has(A)).toBe(true);
    expect(w.backups.count(B)).toBe(400);
  });

  it('中 1：列空日期很慢（前面的日期早删空了，光列它们就超上限）——不在空日期上停，每一轮至少真删掉一个日期', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 650);
    for (let i = 0; i < 640; i++) w.backups.files.delete(`${day(i)}/${A}/notes.json.gz`);   // 前 640 个日期 A 已删空（B 还有）
    toFirstRun(w);
    const left: number[] = [];
    for (let i = 0; i < 20 && w.db.users.has(A); i++) {
      await runPurge(w);
      left.push(w.backups.count(A));
      w.clock.advance(15 * MIN);
    }
    expect(left).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);   // 每轮删掉一个日期就停；最后一个日期做完不停、走完
    expect(w.db.users.has(A)).toBe(false);
  });

  it('中 1（墙钟版）：列一个空日期花 1 秒、删一个日期花 6 秒——墙钟在空日期上过了也不停，删掉一个日期之后才停', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 103);
    for (let i = 0; i < 100; i++) w.backups.files.delete(`${day(i)}/${A}/notes.json.gz`);
    const realList = w.backups.listUserFiles.bind(w.backups);
    const realRemove = w.backups.remove.bind(w.backups);
    w.backups.listUserFiles = async (d, u) => { const r = await realList(d, u); if (r.length === 0) w.clock.advance(1000); return r; };
    w.backups.remove = async (ps) => { await realRemove(ps); w.clock.advance(6000); };
    // 第 1 轮：100 秒列空日期 → 删第 101 个（106 秒）→ 删第 102 个（112 秒，过了 110）停；第 2 轮：再列 102 个空日期 → 最后一个日期做完不停
    toFirstRun(w);
    const left: number[] = [];
    for (let i = 0; i < 10 && w.db.users.has(A); i++) {
      await runPurge(w);
      left.push(w.backups.count(A));
      w.clock.advance(15 * MIN);
    }
    expect(left).toEqual([1, 0]);
    expect(w.db.users.has(A)).toBe(false);
  });
});
