// “全部知道了”（useRemindActions().ackAll）遇到 R4-L1 时返回的条数（第三轮审查补漏测）：
// outbox 里有没发出去的“换一次提醒”的那几条只在本机了结、不算没写进去；其余照常写，返回的是照常写里没写进去的条数
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';

const savePatch = vi.fn(async (..._a: unknown[]): Promise<string> => 'saved');
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => savePatch(...a) }));
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
vi.mock('../../../platform/clock.ts', () => ({
  clock: { now: () => NOW, subscribe: () => () => undefined, offset: () => 0, isClockWrong: () => false },
}));
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined }));
const closeLocalReminder = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: async () => undefined,
  showLocalReminder: async () => undefined,
  closeLocalReminder: (...a: unknown[]) => closeLocalReminder(...a),
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: async () => 0 }));
type ObItem = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
let outboxList: ObItem[] = [];
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ remindRecs: new Set() }), list: async () => outboxList } }),
}));

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const NOW = msAt(DAY, 15 * 60 + 20, SEOUL);
const { useRemindActions } = await import('../hooks/useReminders.ts');
const { allReminders } = await import('../data/reminder-model.ts');

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ev = (n: number) => ({
  id: uuid(n), title: `日程${n}`, date: DAY, time: '15:30', tz: SEOUL, remind_min: 15, duration_min: 60, deleted_at: null, undone: false,
  notified_for: null, snooze_at: null, defer_until: null,
});
const list = allReminders([ev(1), ev(2), ev(3)], [], NOW, SEOUL);
const blocked: ObItem = { rec: `events:${uuid(1)}`, op: 'patch', state: 'pending', data: { date: '2026-11-04', notified_for: null, snooze_at: null } };

beforeEach(() => {
  savePatch.mockReset();
  savePatch.mockImplementation(async () => 'saved');
  closeLocalReminder.mockClear();
  outboxList = [];
});

describe('ackAll 遇到 R4-L1：部分拦、部分照常写', () => {
  it('拦下的一条不写、不算没写进去；其余两条照常写，全写进去返回 0', async () => {
    outboxList = [blocked];
    const { result } = renderHook(() => useRemindActions());
    let left = -1;
    await act(async () => {
      left = await result.current.ackAll(list);
    });
    expect(left).toBe(0);
    expect(savePatch.mock.calls.map((c) => c[1])).toEqual([uuid(2), uuid(3)]);
    expect(closeLocalReminder).toHaveBeenCalledWith(list.find((r) => r.id === uuid(1))?.tag);
  });

  it('照常写的里有一条没写进去：返回 1（拦下的那条不算在里面）', async () => {
    outboxList = [blocked];
    savePatch.mockImplementation(async (...a: unknown[]) => (a[1] === uuid(3) ? 'local_unavailable' : 'saved'));
    const { result } = renderHook(() => useRemindActions());
    let left = -1;
    await act(async () => {
      left = await result.current.ackAll(list);
    });
    expect(left).toBe(1);
    expect(savePatch).toHaveBeenCalledTimes(2);
  });

  it('全拦下：一条都不写，返回 0', async () => {
    outboxList = [1, 2, 3].map((n) => ({ ...blocked, rec: `events:${uuid(n)}` }));
    const { result } = renderHook(() => useRemindActions());
    let left = -1;
    await act(async () => {
      left = await result.current.ackAll(list);
    });
    expect(left).toBe(0);
    expect(savePatch).not.toHaveBeenCalled();
  });
});
