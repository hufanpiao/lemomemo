// anniv-roll（B5 S13；架构 5.4“倒数日到期后”、第 6 节 anniv-roll 行、0.29（P-08）；TC-B5-22、23、TC-B1-109）。
// 证明：鉴权和没配好；每年的滚到下一次、按每条设置 ?? anniv.default_* 重算 remind_at；倒数日 archive 到期第二天写 archived_at、
// 改回以后的清掉；值没变不写；读完被改了不覆盖（stale）；停用、冷静期账号跳过；行不合格记 failed、不影响别的行；心跳只写个数。
// 共享 logic 用真的 shared（和 index.ts 的 _shared/gen 是同一份副本）。
import { describe, expect, it } from 'vitest';
import { addDays, msAt, todayOf } from '../../shared/core/date.ts';
import { isValidTz } from '../../shared/core/tz.ts';
import { annivNextOf } from '../../shared/logic/anniv/next-date.ts';
import { BATCH, handle, type Deps, type HeartbeatDetail, type RollPatch, type RollRow, type RollStore } from '../../supabase/functions/anniv-roll/core.ts';

const SECRET = 's'.repeat(40);
const SEOUL = 'Asia/Seoul';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const NOW = msAt('2026-12-01', 10, 'UTC');   // 00:10 UTC = 首尔 09:10
let seq = 0;
const row = (user: string, over: Partial<RollRow> = {}): RollRow => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, user_id: user, rev: 1, kind: 'birthday', calendar: 'solar', lunar_variant: 'cn',
  month: 11, day: 30, is_leap: false, year: null, remind_offsets: null, remind_time: null, after_due: 'archive', created_at: msAt('2026-01-01', 0, SEOUL),
  next_date: '2026-11-30', remind_at: null, archived_at: null, ...over,
});

function setup(rows: RollRow[], o: { usable?: (u: string) => Promise<boolean>; sets?: Record<string, Record<string, unknown>>; tz?: string } = {}) {
  const writes: { id: string; patch: RollPatch }[] = [];
  const beats: HeartbeatDetail[] = [];
  const codes: string[] = [];
  const store: RollStore = {
    async candidates(lo, hi, limit) {
      expect([lo, hi, limit]).toEqual([addDays(todayOf(NOW, 'UTC'), -1), addDays(todayOf(NOW, 'UTC'), 2), BATCH]);
      return rows;
    },
    async profiles(ids) {
      return new Map(ids.map((u) => [u, o.tz ?? SEOUL]));
    },
    async settings(ids) {
      return new Map(ids.filter((u) => o.sets?.[u]).map((u) => [u, o.sets?.[u] ?? {}]));
    },
    async write(r, patch) {
      if (r.id === 'stale') return false;
      writes.push({ id: r.id, patch });
      return true;
    },
    async writeHeartbeat(d) {
      beats.push(d);
    },
  };
  const deps: Deps = {
    cronSecret: SECRET, store, isUsable: o.usable ?? (async () => true), now: () => NOW, log: (c) => codes.push(c),
    logic: { annivNextOf, todayOf, addDays, isValidTz },
  };
  const call = (secret = SECRET, method = 'POST') => handle(new Request('https://x/anniv-roll', { method, headers: { 'x-cron-secret': secret } }), deps);
  return { writes, beats, codes, call, deps };
}

describe('anniv-roll：鉴权和没配好', () => {
  it('只收 POST；密钥不对 401；没有 store 500', async () => {
    const s = setup([]);
    expect((await s.call(SECRET, 'GET')).status).toBe(405);
    expect((await s.call('x'.repeat(40))).status).toBe(401);
    const r = await handle(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': SECRET } }), { ...s.deps, store: null });
    expect(r.status).toBe(500);
  });
});

describe('anniv-roll：滚动和归档', () => {
  it('每年的生日过了：滚到明年，按设置的默认提醒重算', async () => {
    const r = row(A);
    const s = setup([r], { sets: { [A]: { 'anniv.default_offsets': [1], 'anniv.default_time': '08:00' } } });
    expect((await s.call()).status).toBe(200);
    expect(s.writes).toEqual([{ id: r.id, patch: { next_date: '2027-11-30', remind_at: msAt('2027-11-29', 480, SEOUL), archived_at: null } }]);
    expect(s.beats[0]).toMatchObject({ rows: 1, written: 1, archived: 0 });
  });
  it('倒数日 archive 到期第二天：写 archived_at = 现在，不再提醒；yearly 滚到下一次', async () => {
    const arc = row(A, { kind: 'countdown', year: 2026 });
    const yr = row(A, { kind: 'countdown', year: 2026, after_due: 'yearly' });
    const s = setup([arc, yr]);
    await s.call();
    expect(s.writes).toEqual([
      { id: arc.id, patch: { next_date: '2026-11-30', remind_at: null, archived_at: NOW } },
      { id: yr.id, patch: { next_date: '2027-11-30', remind_at: msAt('2027-11-23', 540, SEOUL), archived_at: null } },
    ]);
    expect(s.beats[0]).toMatchObject({ written: 2, archived: 1 });
  });
  it('已归档的倒数日被改到以后（push-dispatch 已重算 next_date）：清掉 archived_at', async () => {
    const r = row(A, { kind: 'countdown', year: 2027, next_date: '2027-11-30', remind_at: msAt('2027-11-23', 540, SEOUL), archived_at: 123 });
    const s = setup([r]);
    await s.call();
    expect(s.writes).toEqual([{ id: r.id, patch: { next_date: '2027-11-30', remind_at: msAt('2027-11-23', 540, SEOUL), archived_at: null } }]);
  });
  it('值没变不写；读完被改了的不覆盖（stale）；行不合格记 failed、别的照常', async () => {
    const same = row(A, { kind: 'countdown', year: 2026, archived_at: 99 });
    const stale = { ...row(A), id: 'stale' };
    const bad = row(A, { month: 2, day: 30 });
    const ok = row(A);
    const s = setup([same, stale, bad, ok]);
    await s.call();
    expect(s.writes.map((w) => w.id)).toEqual([ok.id]);
    expect(s.beats[0]).toMatchObject({ rows: 4, written: 1, stale: 1, failed: 1 });
    expect(s.codes).toEqual([`bad_anniv anniversaries:${bad.id.slice(0, 8)}`]);   // 整块评审第 11 条：带表名和 id 前 8 位
  });
  it('还有没到的“稍后”、免打扰顺延（snooze_at / defer_until > 现在）：next_date 照滚，remind_at 不动（整块评审第 7 条）', async () => {
    const sn = row(A, { remind_at: 123, snooze_at: NOW + 60_000 });
    const df = row(A, { remind_at: 456, defer_until: NOW + 60_000 });
    const old = row(A, { remind_at: 789, snooze_at: NOW - 60_000 });
    const s = setup([sn, df, old]);
    await s.call();
    expect(s.writes.find((w) => w.id === sn.id)?.patch).toMatchObject({ next_date: '2027-11-30', remind_at: 123 });
    expect(s.writes.find((w) => w.id === df.id)?.patch).toMatchObject({ next_date: '2027-11-30', remind_at: 456 });
    expect(s.writes.find((w) => w.id === old.id)?.patch.remind_at).toBe(msAt('2027-11-23', 540, SEOUL));
  });
  it('判可用账号：几个人并发判，不一个个排队（整块评审第 10 条）', async () => {
    let inflight = 0;
    let peak = 0;
    const usable = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return true;
    };
    const s = setup([row(A), row(B)], { usable });
    await s.call();
    expect(peak).toBe(2);
  });
});

describe('anniv-roll：停用账号（TC-B1-109）', () => {
  it('TC-B1-109 anniv-roll：管理员停用（disabled_at 有值）的账号跳过', async () => {
    const a = row(A);
    const b = row(B);
    const s = setup([a, b], { usable: async (u) => u !== A });
    await s.call();
    expect(s.writes.map((w) => w.id)).toEqual([b.id]);
    expect(s.beats[0]).toMatchObject({ skipped: 1, written: 1 });
  });
  it('TC-B1-109 anniv-roll：注销冷静期（disabled_reason = deletion）的账号跳过', async () => {
    const s = setup([row(A)], { usable: async () => false });
    const r = await s.call();
    expect([s.writes.length, (await r.json()).skipped]).toEqual([0, 1]);
  });
});
