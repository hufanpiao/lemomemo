// R4-L1：日程这一行在 outbox 里还有没上服务器的“换一次提醒”的改动时，“知道了”不写 notified_for（remind-write.ts 的 timingPending、hasTimingChange）
// 第三轮 L9（只看这一行最后一项、要待发没发出过的 patch）、L11（全天 → 有时刻靠 event-edit patchOf 的写法认）；引擎那一半在 RemindEngine.test.tsx
import { describe, expect, it } from 'vitest';
import { hasTimingChange, timingPending } from '../data/remind-write.ts';

const SEOUL = 'Asia/Seoul';
const allDay = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });

describe('R4-L1：outbox 里还有没上服务器的“换一次提醒”的改动时，“知道了”不写 notified_for', () => {
  const id = allDay(1).id;
  const r = { kind: 'event' as const, id };
  type It = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
  const item = (data: Record<string, unknown>, rec = `events:${id}`, over: Partial<It> = {}): It => ({ rec, op: 'patch', state: 'pending', data, ...over });
  it('date、remind_days、time 空 ↔ 非空：算', () => {
    expect(timingPending(r, [item({ date: '2026-11-06', notified_for: null, snooze_at: null })])).toBe(true);
    expect(timingPending(r, [item({ remind_days: 1 })])).toBe(true);
    expect(timingPending(r, [item({ time: null })])).toBe(true);
    expect(timingPending(r, [item({ time: '09:00', tz: SEOUL, notified_for: null, snooze_at: null })])).toBe(true);
  });
  it('只改时刻、标题、别的行、待办：不算', () => {
    expect(timingPending(r, [item({ time: '10:00', tz: SEOUL })])).toBe(false);
    expect(timingPending(r, [item({ title: 'x' })])).toBe(false);
    expect(timingPending(r, [item({ date: '2026-11-06' }, 'events:other')])).toBe(false);
    expect(timingPending({ kind: 'todo', id }, [item({ remind_days: 1 }, `todos:${id}`)])).toBe(false);
    expect(timingPending(r, [])).toBe(false);
  });
});

describe('R4-L1 第三轮 L9：只有这一行最后一项是待发、没发出去过的 patch 才拦', () => {
  const id = allDay(1).id;
  const r = { kind: 'event' as const, id };
  type It = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
  const item = (data: Record<string, unknown>, over: Partial<It> = {}): It => ({ rec: `events:${id}`, op: 'patch', state: 'pending', data, ...over });
  const moved = { date: '2026-11-06', notified_for: null, snooze_at: null };
  it('已经发出去的（正在发、发失败退回 pending 的）：照常写', () => {
    expect(timingPending(r, [item(moved, { state: 'inflight', sent: true })])).toBe(false);
    expect(timingPending(r, [item(moved, { sent: true })])).toBe(false);
  });
  it('永久失败的：照常写', () => {
    expect(timingPending(r, [item(moved, { state: 'failed' })])).toBe(false);
  });
  it('新建还没同步的 insert（带 date）：照常写', () => {
    expect(timingPending(r, [item({ id, date: '2026-11-06', title: 'x' }, { op: 'insert' })])).toBe(false);
  });
  it('“换一次提醒”的后面又跟了一个普通 patch：照常写（并进后面那个，排在后面发）', () => {
    expect(timingPending(r, [item(moved, { state: 'inflight', sent: true }), item({ title: 'y' })])).toBe(false);
    expect(timingPending(r, [item({ title: 'y' }, { sent: true }), item(moved)])).toBe(true);
  });
  it('别的行的项不影响这一行的“最后一项”', () => {
    expect(timingPending(r, [item(moved), { ...item({ title: 'z' }), rec: 'events:other' }])).toBe(true);
  });
});

describe('R4-L1 第三轮 L11：全天 → 有时刻靠 event-edit patchOf 的写法认（time 切换时带 notified_for: null）', () => {
  // 下面是 calendar 的 patchOf 在“全天 → 有时刻”时写出的 patch，形状和 calendar/__tests__/event-edit.test.ts
  // “改了时刻：tz 一起带上”的期望一字不差；那边改了写法，这里和 remind-write.ts 的 hasTimingChange 要跟着改
  it('认得出 patchOf 的切换写法；只改时刻（不带 notified_for）不算', () => {
    expect(hasTimingChange({ time: '09:00', tz: SEOUL, notified_for: null, snooze_at: null, updated_at: 5 })).toBe(true);
    expect(hasTimingChange({ time: null, notified_for: null, snooze_at: null, updated_at: 5 })).toBe(true);
    expect(hasTimingChange({ time: '10:00', tz: SEOUL, updated_at: 5 })).toBe(false);
  });
});
