// 只在本机了结的“知道了”补写（R4-L1 第三轮 L10）的两个边界（第四轮 L13、L14）：
// • L13：补写卡在 await 上时引擎卸载（退出登录、换账号），醒来后不再拿旧账号的行接着写
// • L14：补写正在跑时又来了 outbox 通知，跑完再跑一次，不等下一次变化
// 替身和 RemindEngine.test.tsx 同一套；用 renderHook 同时挂引擎（useRemindEngine）和按钮动作（useRemindActions）
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
const savePatch = vi.fn(async (..._a: unknown[]): Promise<string> => 'saved');
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => savePatch(...a) }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
let nowMs = 0;
vi.mock('../../../platform/clock.ts', () => ({
  clock: { now: () => nowMs, subscribe: () => () => undefined, offset: () => 0, isClockWrong: () => false },
}));
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined }));
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: async () => undefined,
  showLocalReminder: async () => undefined,
  closeLocalReminder: async () => undefined,
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: async () => 0 }));
type ObItem = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
let outboxList: ObItem[] = [];
const outboxSubs = new Set<() => void>();
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({
    outbox: {
      subscribe: (fn: () => void) => {
        outboxSubs.add(fn);
        return () => outboxSubs.delete(fn);
      },
      getStatus: () => ({ remindRecs: new Set() }),
      list: async () => outboxList,
    },
  }),
}));

const { useRemindActions, useRemindEngine, useReminderList } = await import('../hooks/useReminders.ts');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(DAY, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';
const ev = (id: string, time: string): Row => ({
  id, title: id, date: DAY, time, tz: SEOUL, remind_min: 15, duration_min: 60, deleted_at: null, undone: false,
  notified_for: null, snooze_at: null, defer_until: null,
});
const blocked = (id: string): ObItem => ({ rec: `events:${id}`, op: 'patch', state: 'pending', data: { date: '2026-11-04', notified_for: null, snooze_at: null } });
const fireOutbox = (): void => {
  for (const f of [...outboxSubs]) f();
};
/** 等补写链跑完：排两轮宏任务（setTimeout 0）。纯微任务链在下一个宏任务之前一定跑完，不再靠“等 N 次微任务”数次数（接线审查范围外发现） */
const settle = () => act(async () => {
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => setTimeout(r, 0));
});
/** 下一次 savePatch 卡住，直到调返回的 release */
function holdNextSave(): () => void {
  let release: () => void = () => undefined;
  savePatch.mockImplementationOnce(() => new Promise<string>((res) => {
    release = () => res('saved');
  }));
  return () => release();
}

/** 挂引擎和动作；两条都按“知道了”，都因 outbox 里有没发出去的改日期只在本机了结 */
async function mountAndAckBoth() {
  const h = renderHook(() => {
    useRemindEngine();
    return { actions: useRemindActions(), list: useReminderList(nowMs).list };
  });
  outboxList = [blocked(E1), blocked(E2)];
  await act(async () => {
    await h.result.current.actions.ackAll(h.result.current.list);
  });
  expect(savePatch).not.toHaveBeenCalled();
  return h;
}

beforeEach(() => {
  data.events = [ev(E1, '15:30'), ev(E2, '15:45')];
  nowMs = at('15:31');
  outboxList = [];
  outboxSubs.clear();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  savePatch.mockReset();
  savePatch.mockImplementation(async () => 'saved');
});
afterEach(() => cleanup());

describe('补写的两个边界（第四轮）', () => {
  it('L13：补写卡在 await 上时引擎卸载，醒来后不再写下一条（不拿旧账号的行写）', async () => {
    const h = await mountAndAckBoth();
    outboxList = [];
    const release = holdNextSave();
    fireOutbox();
    await waitFor(() => expect(savePatch).toHaveBeenCalledTimes(1));
    expect(savePatch.mock.calls[0]?.[1]).toBe(E1);
    h.unmount();
    release();
    await settle();
    expect(savePatch).toHaveBeenCalledTimes(1);
  });

  it('L14：补写正在跑时又来了 outbox 通知，跑完马上再跑一次，不等下一次变化', async () => {
    await mountAndAckBoth();
    // E1 的改动先发出去了，E2 的还没有
    outboxList = [blocked(E2)];
    const release = holdNextSave();
    fireOutbox();
    await waitFor(() => expect(savePatch).toHaveBeenCalledTimes(1));
    // 正在写 E1 时 E2 的也发出去了，来了一次通知
    outboxList = [];
    fireOutbox();
    release();
    await waitFor(() => expect(savePatch.mock.calls.map((c) => c[1])).toEqual([E1, E2]));
  });
});
