// push-dispatch 第 0 步的两条提示（workers/lemo-ops/src/push-queue.ts；租约出队审查返工，安全审查必改 3、代码审查 L3）：
// queue_ok = 0 连续 3 次抽查才提示；queue_poison > 0 当天提示。usage-report 白名单（DETAIL_FIELDS_BY_NAME['push-dispatch']）放行这两个数。
// 端到端用 lemo-ops-harness.ts（假 fetch 接真的 usage-report/core.ts，白名单是真的那一份）。
import { describe, expect, it } from 'vitest';
import { DETAIL_FIELDS_BY_NAME } from '../../supabase/functions/usage-report/core.ts';
import { evaluatePushQueue, PUSH_QUEUE_POISON, PUSH_QUEUE_STALLED, PUSH_QUEUE_STALLED_ROUNDS } from '../../workers/lemo-ops/src/push-queue.ts';
import { HEARTBEAT_SCOPES } from '../../workers/lemo-ops/src/rules.ts';
import { M, world } from './lemo-ops-harness.ts';

const STALLED = '【柠檬记监控】推送服务的提醒时刻重算一直失败';
const POISON = '【柠檬记监控】有提醒的重算被当成有毒项丢掉了';
const OK = { claimed: 0, sent: 0, failed: 0, budget_hit: false };

describe('evaluatePushQueue', () => {
  it('queue_ok = 0 报“一直失败”（带 minRounds 3）；queue_poison > 0 报“有毒项丢掉了”；正常不报', () => {
    expect(PUSH_QUEUE_STALLED_ROUNDS).toBe(3);
    expect(evaluatePushQueue({ ...OK, queue_ok: 1, queue_poison: 0 })).toEqual([]);
    const a = evaluatePushQueue({ ...OK, queue_ok: 0, queue_poison: 2 });
    expect(a.map((i) => [i.key, i.minRounds])).toEqual([[PUSH_QUEUE_STALLED, 3], [PUSH_QUEUE_POISON, undefined]]);
    expect(a[1]?.lines[0]).toContain('2 项');
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
    const a = evaluatePushQueue({ queue_ok: 0, queue_poison: 3 });
    const b = evaluatePushQueue({ queue_ok: 0, queue_poison: 9 });
    expect(a.map((i) => i.title)).toEqual(b.map((i) => i.title));
    for (const i of a) expect(i.title).not.toMatch(/\d/);
    expect(HEARTBEAT_SCOPES).toContain('push-queue:');
    expect(DETAIL_FIELDS_BY_NAME['push-dispatch']?.num).toEqual(expect.arrayContaining(['queue_ok', 'queue_poison']));
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
