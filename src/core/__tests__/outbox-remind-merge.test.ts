// B2 收尾的两项 outbox 规则（接手清单 REMIND-failed-unsynced、REMIND-offline-ack-merge 本机一半 R4-L1）
// • 同步失败（failed）的带提醒记录也算“未同步”（remindRecs）：它没到服务器，别的设备上同样不会响
// • 两次没发出的 patch 合并时，前一次换了“哪一次提醒”（date、remind_days、time 空↔非空），后来的“知道了”（notified_for）不并进去
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveGoneImpl } from '../outbox-gone.ts';
import { mergePatch } from '../outbox-new-item.ts';
import { outboxCtx, type Outbox } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('REMIND-failed-unsynced：failed 的带提醒记录也算未同步', () => {
  it('永久失败后还在 remindRecs；重试成功（回执）后移出；不带提醒的失败项不算', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await seed(cache, 'todos', uid(2), todo(2), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '坏的' }, remind: true });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '也坏' } });
    for (let n = 0; n < 2; n++) {
      const it = await outbox.next();
      expect(await outbox.fail(it?.op_id ?? '', { status: 400, code: '23514', sid: null })).toBe('permanent');
    }
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 2 });
    expect(outbox.getStatus().remindRecs).toEqual(new Set([`todos:${uid(1)}`]));

    await outbox.retryFailed();
    for (;;) {
      const it = await outbox.next();
      if (!it) break;
      await outbox.ack(it.op_id, { status: 'ok', rev: 6, prev_rev: 5 });
    }
    expect(outbox.getStatus()).toMatchObject({ pending: 0, failed: 0 });
    expect(outbox.getStatus().remindRecs.size).toBe(0);
  });
});

/** 带提醒的 patch 发出去回 gone（另一台设备删了这一条） */
async function remindGone(outbox: Outbox, n: number): Promise<void> {
  await outbox.enqueue({ table: 'todos', id: uid(n), op: 'patch', data: { title: `改${n}` }, remind: true });
  const it = await outbox.next();
  await outbox.fail(it?.op_id ?? '', { status: 409, code: 'gone', sid: null });
}
const rg = (outbox: Outbox, n: number, mode: 'restore' | 'drop', remind: boolean) => {
  const ctx = outboxCtx.get(outbox);
  if (!ctx) throw new Error('outboxCtx');
  return resolveGoneImpl(ctx, 'todos', uid(n), mode, { remindOf: () => remind });
};

describe('REMIND-failed-unsynced：gone 也算，直到恢复或放弃（审查 M1）', () => {
  it('带提醒的 gone 在 remindRecs 里；“不用了”后移出；“恢复”且恢复后不带提醒时移出、带提醒时仍在', async () => {
    const { cache, outbox } = await setup();
    for (const n of [1, 2, 3]) await seed(cache, 'todos', uid(n), todo(n), 5);
    for (const n of [1, 2, 3]) await remindGone(outbox, n);
    expect(outbox.getStatus().remindRecs).toEqual(new Set([1, 2, 3].map((n) => `todos:${uid(n)}`)));
    expect((await rg(outbox, 1, 'drop', false)).done).toBe('dropped');
    expect((await rg(outbox, 2, 'restore', false)).done).toBe('restored');
    expect((await rg(outbox, 3, 'restore', true)).done).toBe('restored');
    expect(outbox.getStatus().remindRecs).toEqual(new Set([`todos:${uid(3)}`]));
  });
});

describe('REMIND-offline-ack-merge（R4-L1 本机）：换了一次提醒以后的“知道了”不并进同一个补丁', () => {
  const OLD = 1_700_000_000_000;

  it('mergePatch：先挪日期（patchOf 带 notified_for: null）再“知道了”→ notified_for 保持 null，别的字段照常合并', () => {
    const moved = { date: '2026-11-07', notified_for: null, snooze_at: null, updated_at: 1 };
    expect(mergePatch(moved, { notified_for: OLD, updated_at: 2 })).toEqual({ date: '2026-11-07', notified_for: null, snooze_at: null, updated_at: 2 });
    // remind_days 改了、全天 → 有时刻（time 带 notified_for: null）、有时刻 → 全天（time: null）一样
    for (const prev of [{ remind_days: 1, notified_for: null }, { time: '09:00', tz: 'Asia/Seoul', notified_for: null }, { time: null, notified_for: null }]) {
      expect(mergePatch(prev, { notified_for: OLD })['notified_for']).toBeNull();
    }
    // 前一次没写 notified_for（别处来的挪日期）：合并后也不带，交给服务器触发器清
    expect('notified_for' in mergePatch({ date: '2026-11-07' }, { notified_for: OLD })).toBe(false);
  });

  it('mergePatch：不换提醒的改动（只改时刻 09:00 → 10:00、标题）照常并进“知道了”；先“知道了”后挪日期，后写的 null 覆盖', () => {
    expect(mergePatch({ time: '10:00', tz: 'Asia/Seoul' }, { notified_for: OLD })['notified_for']).toBe(OLD);
    expect(mergePatch({ title: 'x' }, { notified_for: OLD })['notified_for']).toBe(OLD);
    expect(mergePatch({ notified_for: OLD }, { date: '2026-11-07', notified_for: null })['notified_for']).toBeNull();
    // 后来的不是“知道了”（notified_for 为 null 或没有）：照常覆盖
    expect(mergePatch({ date: '2026-11-07', notified_for: null }, { title: 'y' })).toEqual({ date: '2026-11-07', notified_for: null, title: 'y' });
  });

  it('真 outbox（待办改 remind_days 也是换一次提醒）：离线改完再按“知道了”，合并成一项，补丁里 notified_for 是 null（服务器触发器照常清空，新日期那次照常提醒）', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'todos', uid(1), todo(1), 5);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { remind_days: 1, notified_for: null, snooze_at: null } });
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { notified_for: OLD }, remind: true });
    const items = await outbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.data).toMatchObject({ remind_days: 1, notified_for: null });
    expect(items[0]?.remind).toBe(true);
  });
});
