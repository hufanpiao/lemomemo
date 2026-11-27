// account-purge 心跳的四个数（held、remaining、forced、blocked）：usage-report 按心跳名分开的白名单只放行这几个数字，lemo-ops 的四条提示和边界
// （接手清单 PURGE-heartbeat-ops、PURGE-halfway-flip，安全审查建议 S1、S3；workers/lemo-ops/src/purge-detail.ts、usage-report/core.ts 的 DETAIL_FIELDS_BY_NAME）。
// 端到端那几条用 lemo-ops-harness.ts（假 fetch 接真的 usage-report/core.ts，白名单是真的那一份）。
import { describe, expect, it } from 'vitest';
import { DETAIL_FIELDS_BY_NAME, handle, type Deps, type UsageDb } from '../../supabase/functions/usage-report/core.ts';
import { evaluateHeartbeat, evaluatePurgeDetail, parseHeartbeatReport, PURGE_REMAINING_ROUNDS } from '../../workers/lemo-ops/src/rules.ts';
import { M, world } from './lemo-ops-harness.ts';

const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const HELD = '【柠檬记监控】有到期的注销账号没收到删除前提醒、暂未删除';
const REMAINING = '【柠檬记监控】注销删除连续两天有没做完的账号';
const FORCED = '【柠檬记监控】有注销账号没收到删除前提醒就被删除了';
const BLOCKED = '【柠檬记监控】注销删除被手工改动挡住、可能停在半截';
/** account-purge 真写的心跳键（core.ts 的 detail；account-purge-budget.test.ts 用真函数核对同一份） */
const PURGE_KEYS = ['blocked', 'deferred', 'failed', 'forced', 'held', 'ms', 'ops', 'postponed', 'purged', 'remaining', 'remind_left', 'remind_ops', 'sent'];
const NL = String.fromCharCode(10);

async function forwarded(detail: unknown, name = 'account-purge'): Promise<unknown> {
  const db: UsageDb = {
    heartbeats: async () => [{ name, at: new Date(NOW - M).toISOString(), detail }],
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

describe('usage-report 白名单：按心跳名分开，account-purge 只多放行 held、remaining、forced、blocked', () => {
  it('account-purge 真写的那 13 个键：放行 purged、failed、held、remaining、forced、blocked（和原有的 sent、ms），其余丢掉', async () => {
    const hb = { purged: 2, failed: 1, deferred: 3, held: 4, forced: 1, remaining: 8, blocked: 2, sent: 5, postponed: 1, remind_left: 6, ops: 400, remind_ops: 200, ms: 1234 };
    expect(Object.keys(hb).sort()).toEqual(PURGE_KEYS);
    expect(await forwarded(hb)).toEqual({ purged: 2, failed: 1, held: 4, forced: 1, remaining: 8, blocked: 2, sent: 5, ms: 1234 });
    // 白名单里 account-purge 的每个键它都真写（没有写着玩的）
    for (const k of DETAIL_FIELDS_BY_NAME['account-purge']?.num ?? []) expect(PURGE_KEYS, k).toContain(k);
  });

  it('新键不是非负整数的丢掉（字符串、布尔、对象、数组、null、负数、小数、无穷）；混进来的账号标识一律不转发', async () => {
    expect(await forwarded({ held: '4', remaining: true, forced: { n: 1 }, blocked: [1], purged: 0 })).toEqual({ purged: 0 });
    expect(await forwarded({ held: [1], remaining: null, forced: '1' })).toBeNull();
    expect(await forwarded({ held: -1, remaining: 1.5, forced: Infinity, blocked: Number.NaN, ms: -3, purged: 2 })).toEqual({ purged: 2 });
    const d = await forwarded({ held: 1, user_id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'a@b.test', ids: ['aaaaaaaa'] });
    expect(d).toEqual({ held: 1 });
  });

  it('S1：held、remaining、forced、blocked 只在 account-purge 那一行放行；别的心跳写了同名字段一律丢掉，没登记的心跳名 detail 整个不转发', async () => {
    const same = { held: 1, remaining: 2, forced: 3, blocked: 4 };
    expect(await forwarded({ ...same, claimed: 5, sent: 4, failed: 1, budget_hit: true }, 'push-dispatch')).toEqual({ claimed: 5, sent: 4, failed: 1, budget_hit: true });
    expect(await forwarded({ ...same, rows: 7, ms: 8 }, 'cleanup')).toEqual({ rows: 7, ms: 8 });
    expect(await forwarded({ ...same, rows: 7 }, 'ai-classify')).toBeNull();
    expect(await forwarded({ ...same }, '__proto__')).toBeNull();
    expect(await forwarded({ ...same }, 'toString')).toBeNull();
    // 四个键只出现在 account-purge 的白名单里
    for (const [name, allow] of Object.entries(DETAIL_FIELDS_BY_NAME)) {
      for (const k of Object.keys(same)) expect(allow.num.includes(k), `${name}.${k}`).toBe(name === 'account-purge');
    }
    // P1（PURGE-flip-low）：只认 detail 自己的属性，原型链上继承来的不算（钉住 pickDetail 取值处的 Object.hasOwn）
    expect(await forwarded(Object.assign(Object.create({ held: 3, blocked: 2 }) as object, { purged: 1 }))).toEqual({ purged: 1 });
    expect(await forwarded(Object.create({ claimed: 5, budget_hit: true }) as object, 'push-dispatch')).toBeNull();
    // account-purge 不收布尔
    expect(await forwarded({ budget_hit: true, purged: 1 })).toEqual({ purged: 1 });
  });
});

describe('lemo-ops 判断：四条提示的边界', () => {
  it('held：0 不报，1 就报（当天，不设宽限）；forced、blocked 同样；remaining：大于 0 才算，且要连续 104 轮（26 小时）', () => {
    expect(evaluatePurgeDetail({ held: 0, remaining: 0, forced: 0, blocked: 0 })).toEqual([]);
    const one = evaluatePurgeDetail({ held: 1, remaining: 1, forced: 1, blocked: 1 });
    expect(one.map((i) => i.key)).toEqual(['purge:held', 'purge:remaining', 'purge:forced', 'purge:blocked']);
    expect(one.map((i) => i.minRounds)).toEqual([undefined, 104, undefined, undefined]);
    expect(PURGE_REMAINING_ROUNDS).toBe(104);
  });

  it('字段不是非负整数的不判（负数、小数、字符串、缺字段、detail 不是对象）', () => {
    for (const d of [{ held: -1 }, { held: 1.5 }, { held: '2' }, { blocked: -1 }, { blocked: 0.5 }, { blocked: '1' }, {}, null, [1], 'x']) expect(evaluatePurgeDetail(d), JSON.stringify(d)).toEqual([]);
  });

  it('标题不带个数（个数变了不算新的一件事）；正文写个数，不写 user_id、邮箱', () => {
    const a = evaluatePurgeDetail({ held: 2, remaining: 3, forced: 4, blocked: 5 });
    const b = evaluatePurgeDetail({ held: 9, remaining: 9, forced: 9, blocked: 9 });
    expect(a.map((i) => i.title)).toEqual(b.map((i) => i.title));
    for (const i of a) {
      expect(i.title).not.toMatch(/\d/);
      expect(i.lines.join(NL)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/);
    }
    expect(a[0]?.lines[0]).toContain('有 2 个到期账号没删');
    expect(a[1]?.lines[0]).toContain('还有 3 个到期账号没做成');
    expect(a[2]?.lines[0]).toContain('照删了 4 个没收到删除前提醒的账号');
    expect(a[3]?.lines[0]).toContain('有 5 个到期账号认领后再核对不过');
    // P3、Q1：blocked 的账号满 1 天后也会触发 purge:overdue，正文点明会算进那条、个数可能更多
    expect(a[3]?.lines.join(NL)).toContain('也会算进“注销冷静期已满、超过 1 天还没删除”那条提示；那条的个数比这里多的，多出来的是别的原因');
  });

  it('S3：detail 里就算带了 user_id、邮箱、名字（白名单之外），标题和正文也不出现这些值', () => {
    const uid = 'aaaaaaaa-0000-4000-8000-000000000001';
    const leak = { user_id: uid, email: 'leak@b.test', name: '张三', ids: [uid] };
    const out = evaluatePurgeDetail({ held: 1, remaining: 1, forced: 1, blocked: 1, ...leak });
    expect(out).toHaveLength(4);
    const text = out.map((i) => [i.title, ...i.lines].join(NL)).join(NL);
    for (const v of [uid, uid.slice(0, 8), 'leak@b.test', 'leak', '张三']) expect(text, v).not.toContain(v);
    expect(text).not.toContain('undefined');
  });

  it('purge:overdue 的正文提到 skip_admin、skip_not_disabled（可能是被手工改动挡住的）', () => {
    const r = parseHeartbeatReport({ ok: true, long_tx: 0, heartbeats: [{ name: 'account-purge', age_s: 60, detail: null }],
      pending_deletions: [{ purge_after: '2026-11-01T00:00:00Z', purge_started_at: null, overdue_s: 2 * 86400, started_age_s: null }] });
    if (!r) throw new Error('解析失败');
    const o = evaluateHeartbeat(r, []).active.find((i) => i.key === 'purge:overdue');
    expect(o?.lines.join(NL)).toContain('skip_admin、skip_not_disabled');
  });

  it('evaluateHeartbeat 只看 account-purge 那一行的 detail（别的心跳写了同名字段不算）', () => {
    const r = parseHeartbeatReport({ ok: true, long_tx: 0, pending_deletions: [], heartbeats: [
      { name: 'push-dispatch', age_s: 60, detail: { held: 5, forced: 5, remaining: 5, blocked: 5 } },
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

  it('blocked > 0：这一轮就发一封；没人处理就一直在（6 小时内不重发），处理完回到 0 两轮后发“已恢复”', async () => {
    const w = world();
    w.setPurgeDetail({ blocked: 1 });
    await step(w);
    expect(count(w, BLOCKED)).toBe(1);
    for (let i = 0; i < 8; i++) await step(w);   // 2 小时：仍在、不重发
    expect(count(w, BLOCKED)).toBe(1);
    w.setPurgeDetail({ blocked: 0 });
    await step(w);
    await step(w);
    expect(w.inbox.some((m) => m.subject.includes('已恢复') && m.subject.includes('停在半截'))).toBe(true);
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
