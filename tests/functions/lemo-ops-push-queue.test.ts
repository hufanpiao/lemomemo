// push-dispatch 第 0 步的三条提示（workers/lemo-ops/src/push-queue.ts；租约出队审查返工，安全审查必改 3、代码审查 L3；积压那条 R-411 方案 3.7）：
// queue_ok = 0 连续 3 次抽查才提示；queue_poison > 0 当天提示；queue_oldest_s > 900 这一轮提示。usage-report 白名单（DETAIL_FIELDS_BY_NAME['push-dispatch']）放行这些数。
// 端到端用 lemo-ops-harness.ts（假 fetch 接真的 usage-report/core.ts，白名单是真的那一份）。
import { describe, expect, it } from 'vitest';
import { DETAIL_FIELDS_BY_NAME } from '../../supabase/functions/usage-report/core.ts';
import { evaluatePushQueue, PUSH_QUEUE_BACKLOG, PUSH_QUEUE_BACKLOG_S, PUSH_QUEUE_POISON, PUSH_QUEUE_STALLED, PUSH_QUEUE_STALLED_ROUNDS } from '../../workers/lemo-ops/src/push-queue.ts';
import { HEARTBEAT_SCOPES } from '../../workers/lemo-ops/src/rules.ts';
import { M, world } from './lemo-ops-harness.ts';

const STALLED = '【柠檬记监控】推送服务的提醒时刻重算一直失败';
const POISON = '【柠檬记监控】有提醒的重算被当成有毒项丢掉了';
const BACKLOG = '【柠檬记监控】用户改的提醒排队重算等太久了';
const OK = { claimed: 0, sent: 0, failed: 0, budget_hit: false };

describe('evaluatePushQueue', () => {
  it('queue_ok = 0 报“一直失败”（带 minRounds 3）；queue_poison > 0 报“有毒项丢掉了”；正常不报', () => {
    expect(PUSH_QUEUE_STALLED_ROUNDS).toBe(3);
    expect(evaluatePushQueue({ ...OK, queue_ok: 1, queue_poison: 0 })).toEqual([]);
    const a = evaluatePushQueue({ ...OK, queue_ok: 0, queue_poison: 2 });
    expect(a.map((i) => [i.key, i.minRounds])).toEqual([[PUSH_QUEUE_STALLED, 3], [PUSH_QUEUE_POISON, undefined]]);
    expect(a[1]?.lines[0]).toContain('2 项');
    // 写回数据出错（迁移 20261113120000 起计入有毒次数）也会造成，文案让人按 id 查 recalc_write_failed，不只看 round_failed
    expect(a[1]?.lines.join('')).toContain('recalc_write_failed');
    expect(a[1]?.lines.join('')).toContain('queue_poison:<表>:<id 前 8 位>');
  });
  it('queue_oldest_s > 900 报“等太久了”（正文带分钟数和两种项数）；正好 900、没有这个字段、不是非负整数都不报', () => {
    expect(PUSH_QUEUE_BACKLOG_S).toBe(900);
    const base = { ...OK, queue_ok: 1, queue_poison: 0 };
    const a = evaluatePushQueue({ ...base, queue_oldest_s: 1200, queue_wait0: 3, queue_wait_batch: 700 });
    expect(a.map((i) => [i.key, i.minRounds])).toEqual([[PUSH_QUEUE_BACKLOG, undefined]]);
    expect(a[0]?.lines[0]).toContain('20 分钟');
    expect(a[0]?.lines[0]).toContain('用户改的 3 项、批量重算的 700 项');
    for (const v of [900, -1, 1000.5, '1000', undefined]) expect(evaluatePushQueue({ ...base, queue_oldest_s: v }), String(v)).toEqual([]);
  });
  it('字段不是非负整数、detail 不是对象、没有 sent 的：不判', () => {
    for (const d of [{ queue_ok: -1 }, { queue_ok: 0.5 }, { queue_ok: '0' }, { queue_poison: -1 }, { queue_poison: 1.5 }, { queue_poison: '1' }, {}, null, [0], 'x']) {
      expect(evaluatePushQueue(d), JSON.stringify(d)).toEqual([]);
    }
  });
  it('有 sent 却没有 queue_ok（回滚到了租约版之前的 push-dispatch）：按第 0 步失败算，同样带 minRounds 3，正文说明是旧版本', () => {
    const a = evaluatePushQueue(OK);
    expect(a.map((i) => [i.key, i.minRounds])).toEqual([[PUSH_QUEUE_STALLED, 3]]);
    expect(a[0]?.lines[0]).toContain('没有 queue_ok');
    expect(evaluatePushQueue({ ...OK, queue_ok: 0 })[0]?.lines[0]).not.toContain('没有 queue_ok');
  });
  it('标题不带个数；key 在 HEARTBEAT_SCOPES 管的范围里（恢复后能报“已恢复”）；两个数都在 usage-report 白名单里', () => {
    const a = evaluatePushQueue({ queue_ok: 0, queue_poison: 3, queue_oldest_s: 1000 });
    const b = evaluatePushQueue({ queue_ok: 0, queue_poison: 9, queue_oldest_s: 5000 });
    expect(a).toHaveLength(3);
    expect(a.map((i) => i.title)).toEqual(b.map((i) => i.title));
    for (const i of a) expect(i.title).not.toMatch(/\d/);
    expect(HEARTBEAT_SCOPES).toContain('push-queue:');
    expect(DETAIL_FIELDS_BY_NAME['push-dispatch']?.num).toEqual(expect.arrayContaining(['queue_ok', 'queue_poison', 'queue_oldest_s', 'queue_wait0', 'queue_wait_batch']));
  });
});

describe('lemo-ops 端到端（真 usage-report 白名单 → 判断 → 去重发信）', () => {
  const step = async (w: ReturnType<typeof world>) => {
    w.advance(15 * M);
    w.freshAll();
    await w.tick();
  };
  const count = (w: ReturnType<typeof world>, t: string) => w.inbox.filter((m) => m.subject === t).length;

  it('queue_ok = 0：前两次抽查不发，第 3 次才发；中间有一次回到 1 就从头算', async () => {
    const w = world();
    w.setPushDetail({ ...OK, queue_ok: 0, queue_poison: 0 });
    await step(w);
    await step(w);
    expect(count(w, STALLED)).toBe(0);
    w.setPushDetail({ ...OK, queue_ok: 1, queue_poison: 0 });
    await step(w);
    w.setPushDetail({ ...OK, queue_ok: 0, queue_poison: 0 });
    await step(w);
    await step(w);
    expect(count(w, STALLED)).toBe(0);
    await step(w);
    expect(count(w, STALLED)).toBe(1);
  });
  it('回滚到旧 push-dispatch（心跳只有 claimed、sent、failed、budget_hit）：第 3 次抽查发“一直失败”', async () => {
    const w = world();
    w.setPushDetail(OK);
    await step(w);
    await step(w);
    expect(count(w, STALLED)).toBe(0);
    await step(w);
    expect(count(w, STALLED)).toBe(1);
  });
  it('queue_oldest_s > 900：这一轮就发（经真的 usage-report 白名单转发）', async () => {
    const w = world();
    w.setPushDetail({ ...OK, queue_ok: 1, queue_poison: 0, queue_oldest_s: 901, queue_wait0: 1, queue_wait_batch: 0 });
    await step(w);
    expect(count(w, BACKLOG)).toBe(1);
  });
  it('queue_poison > 0：这一轮就发；首尔换日回到 0 两轮后发“已恢复”', async () => {
    const w = world();
    w.setPushDetail({ ...OK, queue_ok: 1, queue_poison: 1 });
    await step(w);
    expect(count(w, POISON)).toBe(1);
    w.setPushDetail({ ...OK, queue_ok: 1, queue_poison: 0 });
    await step(w);
    await step(w);
    expect(w.inbox.some((m) => m.subject.includes('已恢复') && m.subject.includes('有毒项'))).toBe(true);
  });
});
