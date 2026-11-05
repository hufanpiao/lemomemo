// push-dispatch 第 3～8 步的 D3 第 6 点（B2 架构审 D3）：两轮重叠不重复、认领后出错最多一次、缩小版预算、每轮发送条数上限。
// 11-05 从 push-dispatch-round.test.ts 原样搬来（代码审查复审：那个文件超过 max-lines 300）；耗时的完整版在 push-dispatch-budget.test.ts。
import { afterEach, describe, expect, it } from 'vitest';
import { LOGIC, todoRow, UA, UB } from './push-dispatch-mem.ts';
import { closeFakes, fcm, round, world } from './push-dispatch-world.ts';

afterEach(closeFakes);

describe('D3 第 6 点：不重复、最多一次', () => {
  it('两轮人为重叠：每条只发一次（每台设备各一条）', async () => {
    const w = await world({ [UA]: [fcm(), fcm()], [UB]: [fcm()] }, { delayMs: 30 });
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < 15; i++) ids.push(w.db.put('todos', todoRow(i % 2 ? UA : UB, { remind_at: now - i })).id);
    const [a, b] = await Promise.all([round(w.deps({ now: () => now })), round(w.deps({ now: () => now }))]);
    expect((a?.claimed ?? 0) + (b?.claimed ?? 0)).toBe(15);
    const seen = w.pushes().map((x) => `${String(x.p['id'])}@${x.dev}`);
    expect(seen.length).toBe(new Set(seen).size);
    expect(seen).toHaveLength(7 * 2 + 8);   // UA 7 条 × 2 台，UB 8 条 × 1 台
  });
  it('认领后、发出前出错：这一条不再推；它还停在“错过的提醒”里（pushed_for = due_at，notified_for 没写）', async () => {
    const w = await world({ [UA]: [fcm()] });
    const now = Date.now();
    const boom = w.db.put('todos', todoRow(UA, { title: 'BOOM', remind_at: now }));
    const fine = w.db.put('todos', todoRow(UA, { title: 'ok', remind_at: now - 1 }));
    const logic = { ...LOGIC, notify: (i: Parameters<typeof LOGIC.notify>[0]) => { if (i.title === 'BOOM') throw new Error('x'); return LOGIC.notify(i); } };
    expect(await round(w.deps({ now: () => now, logic }))).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
    expect(w.pushes().map((x) => x.p['id'])).toEqual([fine.id]);
    await round(w.deps({ now: () => now + 30_000 }));
    expect(w.pushes().map((x) => x.p['id'])).toEqual([fine.id]);
    const row = w.db.tables.todos.get(boom.id);
    expect(row?.pushed_for).toBe(now);
    expect(row?.notified_for).toBeNull();
    expect(row?.remind_at).toBe(now);
    expect(w.db.logs.find((l) => l.item_id === boom.id)?.code).toBe('build_failed');
  });
  it('预算（缩小版）：替身每个请求拖 300 毫秒、预算 1 秒，60 条：按时返回、budget_hit 对、left 是剩下的条数，下一轮接着发、每条只发一次', async () => {
    const users = Array.from({ length: 3 }, (_, i) => `${String(i + 1).repeat(8)}-0000-4000-8000-0000000000aa`);
    const w = await world(Object.fromEntries(users.map((u) => [u, [fcm()]])), { delayMs: 300 });
    const now = Date.now();
    for (let i = 0; i < 60; i++) w.db.put('todos', todoRow(users[i % 3] as string, { remind_at: now - 60_000 + i }));
    const t0 = Date.now();
    const r1 = await round(w.deps({ limits: { budgetMs: 1000 } }));
    expect(Date.now() - t0).toBeLessThan(1000 + 300 * 2 + 500);
    expect(r1.budget_hit).toBe(true);
    expect(r1.claimed).toBe(r1.sent);
    expect(r1.left).toBe(60 - r1.claimed);
    w.f.setDelay(0);
    let total = r1.claimed;
    for (let i = 0; i < 5 && total < 60; i++) total += (await round(w.deps())).claimed;
    expect(total).toBe(60);
    const ids = w.pushes().map((x) => x.p['id']);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toHaveLength(60);
  });
  it('每轮发送条数上限：超过就停（budget_hit），剩下的下一轮', async () => {
    const w = await world({ [UA]: [fcm(), fcm()] });
    const now = Date.now();
    for (let i = 0; i < 10; i++) w.db.put('todos', todoRow(UA, { remind_at: now - i }));
    const r = await round(w.deps({ now: () => now, limits: { sendLimit: 7 } }));
    expect(r).toMatchObject({ claimed: 3, budget_hit: true, left: 7 });
    expect(w.f.requests).toHaveLength(6);
  });
});
