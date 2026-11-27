// account-purge：提醒和删除之间的两条保证（B1 代码审查 PURGE-cpu-budget 复审中 A、中 B；负责人 11-04 定）：
//   • 中 A“只保证不在同一轮删”：第二段按本轮开始时刻 t0 列到期的，并跳过这一轮刚提醒过（含补发）的；离到期不足 24 小时的不另外顺延；
//   • 中 B“等 3 天后照删并告警”：到期后还没提醒成功的每轮照旧补发；从 purge_after 起超过 3 天还是发不出去的照删（purge_forced_no_notice）；
//     Auth 里没有邮箱的到期直接删（purge_no_email_no_notice）；@lemomemo.test 测试邮箱发不出去，按同一条规则走（TC-B7a-05）。
// 提醒段的上限、补发并顺延本身在 account-purge-remind.test.ts。
import { describe, expect, it } from 'vitest';
import { PURGE_HOLD_MAX_MS, PURGE_WORK_OPS, R2_BUCKETS, type R2 } from '../../supabase/functions/account-purge/core.ts';
import { deletionDoneMail, skipTestRecipients } from '../../supabase/functions/_shared/account-mail.ts';
import { A, H, mailer } from './account-fakes.ts';
import { requestDeletion, runPurge, world, type World } from './account-purge-harness.ts';
import { logTag } from './account-fakes.ts';

const MIN = 60_000;
const SEC = 1000;
const a8 = await logTag(A);   // 日志里认人的 HMAC 标签（安全审查第 11 条）

/** A 申请注销；返回 purge_after（毫秒）。一次提醒都没发过 */
async function pending(w: World, uid = A): Promise<number> {
  await requestDeletion(w, uid);
  const d = w.db.pending.get(uid);
  if (!d) throw new Error('no pending');
  w.box.length = 0;
  return Date.parse(d.purge_after);
}

describe('中 A：不在同一轮里先提醒、后删除', () => {
  it('purge_after 只比本轮开始晚 2 秒、发信花了 5 秒：这一轮发普通提醒、不删；15 分钟后的下一轮才删', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa - 2 * SEC;   // t0
    const slow = mailer(w.box);
    const r = await runPurge(w, { sendMail: async (to, m) => { w.clock.advance(5 * SEC); return slow(to, m); } });
    expect(r.body).toMatchObject({ sent: 1, postponed: 0, purged: 0 });
    expect(w.db.users.has(A)).toBe(true);
    expect(w.db.pending.get(A)).toMatchObject({ notice_sent: true, purge_after: new Date(pa).toISOString() });   // 不另外顺延
    w.clock.advance(15 * MIN);
    expect((await runPurge(w)).body).toMatchObject({ sent: 0, purged: 1 });
    expect(w.box).toHaveLength(2);   // 提醒、彻底删除，分在两轮
  });

  it('第二段按本轮开始时刻 t0 列到期的：前几天已经提醒过、purge_after 比 t0 晚 2 秒、第一段跑了 5 秒——这一轮不删，下一轮删', async () => {
    const w = world();
    const pa = await pending(w);
    const d = w.db.pending.get(A);
    if (d) d.notice_sent = true;
    w.clock.ms = pa - 2 * SEC;   // t0
    const s = w.db.purgeStore();
    const r = await runPurge(w, { store: { ...s, listRemind: async (u, v) => { w.clock.advance(5 * SEC); return s.listRemind(u, v); } } });
    expect(r.body).toMatchObject({ purged: 0, held: 0 });
    expect(w.db.users.has(A)).toBe(true);
    w.clock.advance(15 * MIN);
    expect((await runPurge(w)).body).toMatchObject({ purged: 1 });
  });

  it('这一轮刚提醒过、没顺延成（并发的另一次先把 notice_sent 标成了 true）：第二段列到它也不删（purge_held_just_reminded），下一轮才删', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa + H;
    w.db.beforePostpone = () => { const d = w.db.pending.get(A); if (d) d.notice_sent = true; };   // purge_after 仍在过去
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ sent: 1, postponed: 0, purged: 0, held: 1 });
    expect(r.logs).toContain(`purge_held_just_reminded:${a8}`);
    expect(w.db.users.has(A)).toBe(true);
    w.db.beforePostpone = null;
    w.clock.advance(15 * MIN);
    expect((await runPurge(w)).body).toMatchObject({ sent: 0, purged: 1, held: 0 });
  });
});

describe('中 B：信一直发不出去的，扣满 3 天照删并告警', () => {
  it('3 天内每轮照旧补发、不删（held）；从 purge_after 起超过 3 天还是发不出去就照删，记 purge_forced_no_notice、心跳 forced', async () => {
    const w = world();
    const pa = await pending(w);
    const fail = { sendMail: async () => false };
    expect(PURGE_HOLD_MAX_MS).toBe(DAYS(3));   // 负责人定的 3 天（第三轮低 G：常量改成 4 天要拦住）
    for (const t of [pa + H, pa + DAYS(1), pa + DAYS(3) - MIN]) {
      w.clock.ms = t;
      const r = await runPurge(w, fail);
      expect(r.body, new Date(t).toISOString()).toMatchObject({ sent: 0, purged: 0, held: 1, forced: 0 });
      expect(r.logs).toContain(`remind_mail_failed:${a8}`);   // 每轮照旧试着补发
      expect(r.logs).toContain(`purge_held_no_notice:${a8}`);
      expect(w.db.users.has(A)).toBe(true);
    }
    w.clock.ms = pa + DAYS(3) + MIN;   // 刚过 3 天：这一轮就照删（字面量 3 天，不随常量变）
    const r = await runPurge(w, fail);
    expect(r.logs).not.toContain(`remind_mail_failed:${a8}`);   // 进了照删期，第一段不再补发（第三轮中 C）
    expect(r.body).toMatchObject({ sent: 0, purged: 1, forced: 1, held: 0 });
    expect(r.logs).toContain(`purge_forced_no_notice:${a8}`);
    expect(w.db.users.has(A)).toBe(false);
    expect(w.db.deleted.has(A)).toBe(true);
  });

  it('P1（第三轮中 C）：照删删了一半碰到上限停手，下一轮信又发得出去——不发补发信、不顺延，接着删完；没删成那轮 forced 0、不记告警码（低 G、低 I）', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa + DAYS(3) + MIN;
    const real = w.r2;
    const heavy: R2 = { async deletePrefix(b, p) { const r = await real.deletePrefix(b, p); return b === R2_BUCKETS[0] ? { deleted: PURGE_WORK_OPS * 1000 } : r; } };
    const r1 = await runPurge(w, { sendMail: async () => false, r2: heavy });
    expect(r1.body).toMatchObject({ purged: 0, deferred: 1, forced: 0 });
    expect(r1.logs).toContain(`time_budget:${a8}`);
    expect(r1.logs).toContain(`purge_forced_attempt:${a8}`);
    expect(r1.logs).not.toContain(`purge_forced_no_notice:${a8}`);
    w.clock.advance(15 * MIN);
    const r2 = await runPurge(w);   // 信能发了
    expect(r2.body).toMatchObject({ sent: 0, postponed: 0, purged: 1, forced: 1 });
    expect(r2.logs).toContain(`purge_forced_no_notice:${a8}`);
    expect(w.db.users.has(A)).toBe(false);
    expect(w.box.map((m) => m.mail.subject)).toEqual([deletionDoneMail('zh-CN').subject]);   // 只有“已注销”那一封
  });

  it('P2（第三轮中 C）：照删认领后进程被掐、认领卡住，信又发得出去——不会每轮发补发信；认领过期（1 小时）后照删', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa + DAYS(3) + MIN;
    const d = w.db.pending.get(A);
    if (d) d.purge_started_at = new Date(w.clock.ms).toISOString();   // 被掐的那次留下的认领
    for (let i = 0; i < 4; i++) {
      const r = await runPurge(w);
      expect(r.body, `第 ${i + 1} 轮`).toMatchObject({ sent: 0, postponed: 0, purged: 0 });
      w.clock.advance(15 * MIN);
    }
    expect(w.box).toHaveLength(0);
    w.clock.advance(H);
    expect((await runPurge(w)).body).toMatchObject({ sent: 0, purged: 1, forced: 1 });
  });

  it('正在删的（已认领）不发提醒：还没到 3 天、认领卡住时第一段也不补发（listRemind 排除已认领的，第三轮中 C）', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa + 2 * H;
    const d = w.db.pending.get(A);
    if (d) d.purge_started_at = new Date(w.clock.ms - 10 * MIN).toISOString();
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ sent: 0, postponed: 0, purged: 0 });
    expect(w.box).toHaveLength(0);
    expect(w.db.pending.get(A)).toMatchObject({ notice_sent: false, purge_after: new Date(pa).toISOString() });
  });

  it('扣着的这 3 天里补发成功了：照常顺延 24 小时，不会被照删', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa + DAYS(2);
    await runPurge(w, { sendMail: async () => false });
    w.clock.advance(15 * MIN);
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ sent: 1, postponed: 1, purged: 0, forced: 0 });
    expect(w.db.users.has(A)).toBe(true);
  });

  it('Auth 里没有邮箱（本来就收不到信）：到期直接删，记 remind_no_email、purge_no_email_no_notice', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa + H;
    const r = await runPurge(w, { userEmail: async () => null });
    expect(r.body).toMatchObject({ sent: 0, purged: 1, forced: 1, held: 0 });
    expect(r.logs).toContain(`remind_no_email:${a8}`);
    expect(r.logs).toContain(`purge_no_email_no_notice:${a8}`);
    expect(w.db.users.has(A)).toBe(false);
  });

  it('没有邮箱、但还没到期：只是不发提醒，不删', async () => {
    const w = world();
    const pa = await pending(w);
    w.clock.ms = pa - 24 * H;
    const r = await runPurge(w, { userEmail: async () => null });
    expect(r.body).toMatchObject({ sent: 0, purged: 0 });
    expect(w.db.users.has(A)).toBe(true);
  });

  it('@lemomemo.test 测试邮箱（真函数不真发，算发信失败）：同一条规则——3 天内扣着，超过 3 天照删（TC-B7a-05）', async () => {
    const w = world();
    const T = 'e7e57000-0000-4000-8000-000000000000';
    w.db.addUser(T, 'qa1@lemomemo.test');
    const pa = await pending(w, T);
    const logs: string[] = [];
    const over = { sendMail: skipTestRecipients(mailer(w.box), (c) => logs.push(c)) };
    w.clock.ms = pa + H;
    expect((await runPurge(w, over)).body).toMatchObject({ purged: 0, held: 1 });
    w.clock.ms = pa + DAYS(3) + MIN;
    const r = await runPurge(w, over);
    expect(r.body).toMatchObject({ purged: 1, forced: 1 });
    expect(r.logs).toContain(`purge_forced_no_notice:${await logTag(T)}`);
    expect(logs).toContain('mail_skipped_test');
    expect(w.box).toHaveLength(0);   // 一封都没真发
    expect(w.db.users.has(T)).toBe(false);
  });
});

function DAYS(n: number) { return n * 24 * H; }
