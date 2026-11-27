// account-purge 的提醒段（PURGE-cpu-budget 返工，11-04；B1 代码审查高 1，负责人定“补发并顺延 24 小时”）：
//   • 提醒段用自己的调用次数上限（REMIND_WORK_OPS），超了就停，剩下的交给 15 分钟后的补跑；最急的先发、不重复发；不挤占删除段；
//   • 没收到到期提醒的不删（held）；到期了还没提醒的补发一封“删除时间已顺延”、purge_after 顺延 24 小时，只顺延一次；
//     发信失败不顺延；CAS 冲突不覆盖；顺延以后还能 restore。
// 删除段的预算和半截续删在 account-purge-budget.test.ts。
import { describe, expect, it } from 'vitest';
import { PURGE_TIME_BUDGET_MS, REMIND_LATE_POSTPONE_MS, REMIND_WINDOW_MS, REMIND_WORK_OPS } from '../../supabase/functions/account-purge/core.ts';
import { deletionDoneMail, deletionReminderLateMail, deletionReminderMail, deletionRequestedMail } from '../../supabase/functions/_shared/account-mail.ts';
import { A, DAY, H, T0 } from './account-fakes.ts';
import { markNoticed, requestDeletion, runPurge, world, type World } from './account-purge-harness.ts';
import { tzLabel } from '../../shared/i18n/tz-label.ts';
import { logTag } from './account-fakes.ts';
const tA = await logTag(A);   // 日志里认人的 HMAC 标签（安全审查第 11 条）

const MIN = 60_000;

describe('提醒段：自己的上限，超了就停、下一轮接着发，最急的先发，不重复发', () => {
  /** n 个待删账号，申请时刻每个晚 1 分钟（purge_after 各不相同），邮箱 u<i>@test.local */
  async function many(w: World, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;   // 前 8 位各不相同（假库的会话按前 8 位起名）
      w.db.addUser(id, `u${i}@test.local`);
      w.clock.ms = T0 + i * MIN;
      await requestDeletion(w, id);
      ids.push(id);
    }
    return ids;
  }

  it('60 个账号同在 48 小时窗口里：第一轮发到上限就停（remind_budget），15 分钟后发完剩下的，第三轮一封不发；每人正好一封、按 purge_after 先后', async () => {
    const w = world();
    const ids = await many(w, 60);
    w.box.length = 0;
    w.clock.ms = T0 + 7 * DAY - 24 * H;
    const k = Math.ceil((REMIND_WORK_OPS - 1) / 4);   // 列一次 + 每封 4 次（取邮箱、取 profile、发信、标记）
    const r1 = await runPurge(w);
    expect(r1.body).toMatchObject({ sent: k, remind_left: 60 - k });
    expect(r1.logs).toContain(`remind_budget:${60 - k}`);
    expect(w.box.map((m) => m.to)).toEqual(ids.slice(0, k).map((_, i) => `u${i}@test.local`));   // 最急的先发
    w.clock.advance(15 * MIN);
    const r2 = await runPurge(w);
    expect(r2.body).toMatchObject({ sent: 60 - k, remind_left: 0 });
    w.clock.advance(15 * MIN);
    expect((await runPurge(w)).body).toMatchObject({ sent: 0, remind_left: 0 });
    expect(w.box).toHaveLength(60);
    expect(new Set(w.box.map((m) => m.to)).size).toBe(60);
    for (const id of ids) expect(w.db.pending.get(id)?.notice_sent).toBe(true);
  });

  it('库那边返回的顺序乱了（倒序），core.ts 自己也按 purge_after 排：第一轮发的仍是最急的那些（复审低 C）', async () => {
    const w = world();
    const ids = await many(w, 60);
    w.box.length = 0;
    w.clock.ms = T0 + 7 * DAY - 24 * H;
    const s = w.db.purgeStore();
    const k = Math.ceil((REMIND_WORK_OPS - 1) / 4);
    const r = await runPurge(w, { store: { ...s, listRemind: async (u, v) => [...await s.listRemind(u, v)].reverse() } });
    expect(r.body).toMatchObject({ sent: k, remind_left: 60 - k });
    expect(w.box.map((m) => m.to)).toEqual(ids.slice(0, k).map((_, i) => `u${i}@test.local`));
  });

  it('照删期（到期超过 3 天）的不进提醒候选：第一段碰上限时 remind_left 只算窗口里没发的（PURGE-r4-low 低 L）', async () => {
    const w = world();
    const held: string[] = [];
    for (let i = 0; i < 5; i++) {   // 5 个到期超过 3 天、一直没提醒成功的（申请时刻比窗口里的早 5 天）
      const id = `e${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
      w.db.addUser(id, `h${i}@test.local`);
      w.clock.ms = T0 - 5 * DAY + i * MIN;
      await requestDeletion(w, id);
      held.push(id);
    }
    await many(w, 60);
    w.box.length = 0;
    w.clock.ms = T0 + 7 * DAY - 24 * H;
    const s = w.db.purgeStore();
    const seen: string[] = [];
    const k = Math.ceil((REMIND_WORK_OPS - 1) / 4);
    const r = await runPurge(w, { store: { ...s, listRemind: async (u, v) => { const rows = await s.listRemind(u, v); seen.push(...rows.map((x) => x.user_id)); return rows; } } });
    expect(r.body).toMatchObject({ sent: k, remind_left: 60 - k });
    expect(seen.filter((u) => held.includes(u))).toEqual([]);
    // 它们这一轮被第二段照删，只收到“已注销”那一封，没有提醒、补发
    expect(w.box.filter((m) => m.to.startsWith('h')).map((m) => m.mail.subject)).toEqual(held.map(() => deletionDoneMail('zh-CN').subject));
  });

  it('提醒多也不挤占删除：60 封提醒的同一轮里，到期的 A 照样删掉', async () => {
    const w = world();
    await requestDeletion(w, A);
    await many(w, 60);
    markNoticed(w);
    for (const [id, d] of w.db.pending) if (id !== A) d.notice_sent = false;   // 只有 A 提醒过
    const pa = w.db.pending.get(A);
    if (!pa) throw new Error('no pending');
    w.clock.ms = Date.parse(pa.purge_after) + MIN;   // A 刚到期，其余 60 个都在窗口里
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ purged: 1 });
    expect(Number(r.body['sent'])).toBeGreaterThan(0);
    expect(w.db.users.has(A)).toBe(false);
  });

  it('两段的上限互不相干：提醒段的调用次数不算进删除段（心跳 ops、remind_ops 各记各的）', async () => {
    const w = world();
    await many(w, 60);
    w.clock.ms = T0 + 7 * DAY - 24 * H;
    const r = await runPurge(w);
    expect(Number(r.body['remind_ops'])).toBeGreaterThanOrEqual(REMIND_WORK_OPS);
    expect(Number(r.body['ops'])).toBeLessThan(5);   // 删除段只列了一次到期的
  });
});

describe('到期了还没提醒：补发并顺延 24 小时（负责人 11-04 定，架构 0.29 续第 137 条④）', () => {
  /** A 申请注销，跳到到期后 1 小时，一次提醒都没发过 */
  async function overdue(w: World) {
    await requestDeletion(w, A);
    const d = w.db.pending.get(A);
    if (!d) throw new Error('no pending');
    w.clock.ms = Date.parse(d.purge_after) + H;
    w.box.length = 0;
    return d.purge_after;
  }

  it('补发：发“删除时间已顺延”的信（写新的时刻），notice_sent → true、purge_after → 现在 + 24 小时，这一轮不删', async () => {
    const w = world();
    await overdue(w);
    const now = w.clock.ms;
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ sent: 1, postponed: 1, purged: 0, held: 0 });
    expect(r.logs).toContain(`purge_postponed:${tA}`);
    expect(w.db.pending.get(A)).toMatchObject({ notice_sent: true, purge_after: new Date(now + REMIND_LATE_POSTPONE_MS).toISOString() });
    expect(w.box.map((m) => m.mail.subject)).toEqual([deletionReminderLateMail('zh-CN', 0, 'Asia/Seoul', tzLabel).subject]);
    expect(w.box[0]?.mail.text).toBe(deletionReminderLateMail('zh-CN', now + REMIND_LATE_POSTPONE_MS, 'Asia/Seoul', tzLabel).text);
    expect(w.db.users.has(A)).toBe(true);
  });

  it('顺延只一次：新的时刻之前每 15 分钟跑都不再发信；到了新的时刻照常删除。A 一共收三封（申请、补发的提醒、彻底删除）', async () => {
    const w = world();
    w.clock.ms = T0;
    await requestDeletion(w, A);
    const d = w.db.pending.get(A);
    if (!d) throw new Error('no pending');
    w.clock.ms = Date.parse(d.purge_after) + H;
    await runPurge(w);
    const newPa = Date.parse(w.db.pending.get(A)?.purge_after ?? '');
    for (let t = w.clock.ms + 15 * MIN; t < newPa; t += 15 * MIN) {
      w.clock.ms = t;
      const r = await runPurge(w);
      expect(r.body).toMatchObject({ sent: 0, postponed: 0, purged: 0 });
    }
    w.clock.ms = newPa + MIN;
    expect((await runPurge(w)).body).toMatchObject({ purged: 1, postponed: 0 });
    expect(w.box.map((m) => m.mail.subject)).toEqual([
      deletionRequestedMail('zh-CN', 0, 'Asia/Seoul', tzLabel).subject,
      deletionReminderLateMail('zh-CN', 0, 'Asia/Seoul', tzLabel).subject,
      deletionDoneMail('zh-CN').subject,
    ]);
    for (const m of w.box) expect(m.mail.text).not.toMatch(/http/);
  });

  it('发信失败不顺延：notice_sent、purge_after 都不动，第二段也不删（held，告警日志）；下一次发成功才顺延', async () => {
    const w = world();
    const pa0 = await overdue(w);
    const r = await runPurge(w, { sendMail: async () => false });
    expect(r.body).toMatchObject({ sent: 0, postponed: 0, purged: 0, held: 1, remaining: 1 });
    expect(r.logs).toContain(`remind_mail_failed:${tA}`);
    expect(r.logs).toContain(`purge_held_no_notice:${tA}`);
    expect(w.db.pending.get(A)).toMatchObject({ notice_sent: false, purge_after: pa0, purge_started_at: null });
    expect(w.db.users.has(A)).toBe(true);
    w.clock.advance(15 * MIN);
    const now = w.clock.ms;
    expect((await runPurge(w)).body).toMatchObject({ sent: 1, postponed: 1, held: 0 });
    expect(w.db.pending.get(A)?.purge_after).toBe(new Date(now + REMIND_LATE_POSTPONE_MS).toISOString());
  });

  it('CAS 冲突：信发出去以后这一行被别的一次先顺延了 → 这次不再改（remind_postpone_skipped），也不删', async () => {
    const w = world();
    await overdue(w);
    const other = new Date(w.clock.ms + REMIND_LATE_POSTPONE_MS - MIN).toISOString();
    w.db.beforePostpone = () => { const d = w.db.pending.get(A); if (d) { d.notice_sent = true; d.purge_after = other; } };
    const r = await runPurge(w);
    expect(r.logs).toContain(`remind_postpone_skipped:${tA}`);
    expect(r.body).toMatchObject({ sent: 1, postponed: 0, purged: 0 });
    expect(w.db.pending.get(A)?.purge_after).toBe(other);   // 别人的顺延不被覆盖
    expect(w.db.users.has(A)).toBe(true);
  });

  it('CAS 冲突：信发出去以后被认领了 / 被 restore 删了 → 不顺延；没顺延的仍不删', async () => {
    for (const how of ['claimed', 'restored'] as const) {
      const w = world();
      const pa0 = await overdue(w);
      w.db.beforePostpone = () => {
        if (how === 'restored') { w.db.pending.delete(A); return; }
        const d = w.db.pending.get(A);
        if (d) d.purge_started_at = new Date(w.clock.ms).toISOString();
      };
      const r = await runPurge(w);
      expect(r.logs, how).toContain(`remind_postpone_skipped:${tA}`);
      expect(r.body, how).toMatchObject({ postponed: 0, purged: 0 });
      if (how === 'claimed') expect(w.db.pending.get(A)).toMatchObject({ notice_sent: false, purge_after: pa0 });
      expect(w.db.users.has(A), how).toBe(true);
    }
  });

  it('顺延以后还能 restore（新的 purge_after 在将来）', async () => {
    const w = world();
    const pa0 = await overdue(w);
    expect(w.db.restore(A)).toBe('expired');   // 顺延之前：已到期，restore 拒
    // restore 拒了，pending 行还在；补发并顺延
    await runPurge(w);
    w.clock.advance(23 * H);
    expect(Date.parse(w.db.pending.get(A)?.purge_after ?? '')).toBeGreaterThan(Date.parse(pa0));
    expect(w.db.restore(A)).toBe('ok');
    expect(w.db.pending.has(A)).toBe(false);
    expect(w.db.profiles.get(A)?.disabled_at).toBeNull();
  });

  it('正常窗口里的提醒不顺延：purge_after 不变，用原来的到期提醒文案', async () => {
    const w = world();
    await requestDeletion(w, A);
    const pa0 = w.db.pending.get(A)?.purge_after ?? '';
    w.clock.ms = Date.parse(pa0) - REMIND_WINDOW_MS / 2;
    w.box.length = 0;
    expect((await runPurge(w)).body).toMatchObject({ sent: 1, postponed: 0 });
    expect(w.db.pending.get(A)).toMatchObject({ notice_sent: true, purge_after: pa0 });
    expect(w.box[0]?.mail.subject).toBe(deletionReminderMail('zh-CN', 0, 'Asia/Seoul', tzLabel).subject);
  });

  it('补发的信：中、韩两种都写新的时刻、没有链接、写“恢复账号”', () => {
    const at = Date.parse('2026-11-07T03:00:00Z');
    const zh = deletionReminderLateMail('zh-CN', at, 'Asia/Seoul', tzLabel);
    const ko = deletionReminderLateMail('ko-KR', at, 'Asia/Seoul', tzLabel);
    expect(zh.text).toContain('2026年11月7日 12:00（韩国时间）');
    expect(ko.text).toContain('2026년 11월 7일 12:00 (한국 시간)');
    expect(zh.text).toContain('恢复账号');
    expect(ko.text).toContain('계정 복구');
    for (const m of [zh, ko]) expect(`${m.subject}${m.text}`).not.toMatch(/http|lemomemo/);
  });

  it('墙钟上限仍是两段共用的兜底（110 秒）', () => {
    expect(PURGE_TIME_BUDGET_MS).toBe(110_000);
    expect(REMIND_LATE_POSTPONE_MS).toBe(24 * H);
  });
});
