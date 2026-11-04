// account-purge 心跳的三个数（held、remaining、forced）：usage-report 白名单只放行这三个数字，lemo-ops 的三条提示和边界
// （接手清单 PURGE-heartbeat-ops；workers/lemo-ops/src/purge-detail.ts、supabase/functions/usage-report/core.ts 的 DETAIL_FIELDS）。
// 端到端那几条用 lemo-ops-harness.ts（假 fetch 接真的 usage-report/core.ts，白名单是真的那一份）。
import { describe, expect, it } from 'vitest';
import { handle, type Deps, type UsageDb } from '../../supabase/functions/usage-report/core.ts';
import { evaluateHeartbeat, evaluatePurgeDetail, parseHeartbeatReport, PURGE_REMAINING_ROUNDS } from '../../workers/lemo-ops/src/rules.ts';
import { M, world } from './lemo-ops-harness.ts';

const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const HELD = '【柠檬记监控】有到期的注销账号没收到删除前提醒、暂未删除';
const REMAINING = '【柠檬记监控】注销删除连续两天有没做完的账号';
const FORCED = '【柠檬记监控】有注销账号没收到删除前提醒就被删除了';

async function forwarded(detail: unknown): Promise<unknown> {
  const db: UsageDb = {
    heartbeats: async () => [{ name: 'account-purge', at: new Date(NOW - M).toISOString(), detail }],
    pendingDeletions: async () => [],
    longTxCount: async () => 0,
  };
  const deps: Deps = { opsSecret: SECRET, db, now: () => NOW };
  const res = await handle(new Request('https://x.supabase.co/functions/v1/usage-report', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ops-secret': SECRET }, body: JSON.stringify({ part: 'heartbeat' }),
  }), deps);
  const b = (await res.json()) as { heartbeats: Array<{ detail: unknown }> };
  return b.heartbeats[0]?.detail;
}

describe('usage-report 白名单：account-purge 心跳只多放行 held、remaining、forced 三个数字', () => {
  it('account-purge 真写的那 12 个键：放行 purged、failed、held、remaining、forced（和原有的 sent、ms），其余丢掉', async () => {
    const hb = { purged: 2, failed: 1, deferred: 3, held: 4, forced: 1, remaining: 8, sent: 5, postponed: 1, remind_left: 6, ops: 400, remind_ops: 200, ms: 1234 };
    expect(await forwarded(hb)).toEqual({ purged: 2, failed: 1, held: 4, forced: 1, remaining: 8, sent: 5, ms: 1234 });
  });

  it('三个新键不是数字的丢掉（字符串、布尔、对象、数组、null）；混进来的账号标识一律不转发', async () => {
    expect(await forwarded({ held: '4', remaining: true, forced: { n: 1 }, purged: 0 })).toEqual({ purged: 0 });
    expect(await forwarded({ held: [1], remaining: null, forced: '1' })).toBeNull();
    const d = await forwarded({ held: 1, user_id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'a@b.test', ids: ['aaaaaaaa'] });
    expect(d).toEqual({ held: 1 });
  });
});

describe('lemo-ops 判断：三条提示的边界', () => {
  it('held：0 不报，1 就报（当天，不设宽限）；forced 同样；remaining：大于 0 才算，且要连续 104 轮（26 小时）', () => {
    expect(evaluatePurgeDetail({ held: 0, remaining: 0, forced: 0 })).toEqual([]);
    const one = evaluatePurgeDetail({ held: 1, remaining: 1, forced: 1 });
    expect(one.map((i) => i.key)).toEqual(['purge:held', 'purge:remaining', 'purge:forced']);
    expect(one.map((i) => i.minRounds)).toEqual([undefined, 104, undefined]);
    expect(PURGE_REMAINING_ROUNDS).toBe(104);
  });

  it('字段不是非负整数的不判（负数、小数、字符串、缺字段、detail 不是对象）', () => {
    for (const d of [{ held: -1 }, { held: 1.5 }, { held: '2' }, {}, null, [1], 'x']) expect(evaluatePurgeDetail(d), JSON.stringify(d)).toEqual([]);
  });

  it('标题不带个数（个数变了不算新的一件事）；正文写个数，不写 user_id、邮箱', () => {
    const a = evaluatePurgeDetail({ held: 2, remaining: 3, forced: 4 });
    const b = evaluatePurgeDetail({ held: 9, remaining: 9, forced: 9 });
    expect(a.map((i) => i.title)).toEqual(b.map((i) => i.title));
    for (const i of a) {
      expect(i.title).not.toMatch(/\d/);
      expect(i.lines.join('\n')).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/);
    }
    expect(a[0]?.lines[0]).toContain('有 2 个到期账号没删');
    expect(a[1]?.lines[0]).toContain('还有 3 个到期账号没做成');
    expect(a[2]?.lines[0]).toContain('照删了 4 个没收到删除前提醒的账号');
  });

  it('evaluateHeartbeat 只看 account-purge 那一行的 detail（别的心跳写了同名字段不算）', () => {
    const r = parseHeartbeatReport({ ok: true, long_tx: 0, pending_deletions: [], heartbeats: [
      { name: 'push-dispatch', age_s: 60, detail: { held: 5, forced: 5, remaining: 5 } },
      { name: 'account-purge', age_s: 60, detail: { held: 0, forced: 1, remaining: 0 } },
    ] });
    if (!r) throw new Error('解析失败');
    expect(evaluateHeartbeat(r, []).active.filter((i) => i.key.startsWith('purge:')).map((i) => i.key)).toEqual(['purge:forced']);
  });
});

describe('lemo-ops 端到端（真 usage-report 白名单 → 判断 → 去重发信）', () => {
  const step = async (w: ReturnType<typeof world>) => {
    w.advance(15 * M);
    w.freshAll();
    await w.tick();
  };
  const count = (w: ReturnType<typeof world>, t: string) => w.inbox.filter((m) => m.subject === t).length;

  it('held > 0：这一轮就发一封；回到 0 两轮后发“已恢复”', async () => {
    const w = world();
    w.setPurgeDetail({ held: 1, remaining: 1, forced: 0 });
    await step(w);
    expect(count(w, HELD)).toBe(1);
    w.setPurgeDetail({ held: 0, remaining: 0, forced: 0 });
    await step(w);
    await step(w);
    expect(w.inbox.some((m) => m.subject.includes('已恢复') && m.subject.includes('暂未删除'))).toBe(true);
  });

  it('forced > 0：这一轮就发一封（要人看一眼发信）', async () => {
    const w = world();
    w.setPurgeDetail({ held: 0, remaining: 0, forced: 2 });
    await step(w);
    expect(count(w, FORCED)).toBe(1);
  });

  it('remaining > 0：连续 103 轮不发，第 104 轮（26 小时）才发；中间有一轮回到 0 就从头算', async () => {
    const w = world();
    w.setPurgeDetail({ held: 0, remaining: 3, forced: 0 });
    for (let i = 1; i < PURGE_REMAINING_ROUNDS; i++) await step(w);
    expect(count(w, REMAINING)).toBe(0);
    await step(w);
    expect(count(w, REMAINING)).toBe(1);

    const v = world();
    v.setPurgeDetail({ remaining: 3 });
    for (let i = 0; i < 100; i++) await step(v);
    v.setPurgeDetail({ remaining: 0 });   // 有一轮清到 0（比如第二天的补跑做完了）
    await step(v);
    v.setPurgeDetail({ remaining: 3 });
    for (let i = 1; i < PURGE_REMAINING_ROUNDS; i++) await step(v);
    expect(count(v, REMAINING)).toBe(0);
    await step(v);
    expect(count(v, REMAINING)).toBe(1);
  });
});
