// 只在本机了结的“知道了”补写（useReminders 补写 effect）的两个测试缺口（接手清单 REMIND-later-ack-tests，第四轮审查补）：
// ① 读 outbox 之后那道 alive 检查：旧引擎卡在 outbox.list() 上时换了账号、新引擎又记了待补写，旧的醒来不能拿自己的行去写
//    （remind-later-ack.test.tsx 的 L13 只卡在 savePatch 上，去掉这道检查它照样过）
// ② dirty 再跑会停下来：每次写入都发一次 outbox 通知，写入次数不超过待补写条数，outbox 也不会被一直读下去
// 替身和 remind-later-ack.test.tsx 同一套，只把 outbox.list 换成可卡住、可计数的
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
// outbox 状态替身的空集合（UNSYNCED-retryRecs-required）：每次返回同一个对象，useSyncExternalStore 的快照才稳定
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());

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
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined, isKeyboardOpen: () => false }));
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: async () => undefined,
  showLocalReminder: async () => undefined,
  closeLocalReminder: async () => undefined,
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: async () => 0 }));
type ObItem = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
let outboxList: ObItem[] = [];
/** outbox.list 的实现：默认返回 outboxList；单条测试可以换成卡住的 */
let listImpl: () => Promise<ObItem[]> = async () => outboxList;
const listCalls = { n: 0 };
const countedList = (): Promise<ObItem[]> => {
  listCalls.n++;
  return listImpl();
};
const outboxSubs = new Set<() => void>();
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({
    outbox: {
      subscribe: (fn: () => void) => {
        outboxSubs.add(fn);
        return () => outboxSubs.delete(fn);
      },
      getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs: EMPTY_RECS }),
      list: () => countedList(),
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
  listImpl = async () => outboxList;
  listCalls.n = 0;
  outboxSubs.clear();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  savePatch.mockReset();
  savePatch.mockImplementation(async () => 'saved');
});
afterEach(() => cleanup());

describe('补写的两个测试缺口（REMIND-later-ack-tests）', () => {
  it('① 卡在读 outbox 上时换账号：旧引擎醒来不写（读 outbox 之后的 alive 检查）', async () => {
    const a = await mountAndAckBoth();
    // 下一次读 outbox 卡住：旧引擎的补写停在 await outboxItems() 上
    let release: (items: ObItem[]) => void = () => undefined;
    listImpl = () => new Promise<ObItem[]>((res) => {
      release = res;
    });
    const read0 = listCalls.n;
    fireOutbox();
    // 旧引擎已经在读 outbox（卡住了）
    await waitFor(() => expect(listCalls.n).toBe(read0 + 1));
    await settle();
    expect(savePatch).not.toHaveBeenCalled();
    // 换账号：旧引擎卸载（清掉待补写），新引擎挂上、两条又只在本机了结，待补写里又有了这两条
    a.unmount();
    listImpl = async () => outboxList;
    await mountAndAckBoth();
    // 旧引擎读到的 outbox 是空的：没有这道检查，它会拿旧引擎的行把新引擎记下的两条写掉
    release([]);
    await settle();
    expect(savePatch).not.toHaveBeenCalled();
  });

  it('② 每次写入都发一次 outbox 通知：dirty 再跑会停下来，写入次数不超过待补写条数', async () => {
    await mountAndAckBoth();
    // 写到 10 次就不再发通知：真停不下来时让断言失败，而不是把测试进程拖死
    savePatch.mockImplementation(async () => {
      if (savePatch.mock.calls.length <= 10) fireOutbox();
      return 'saved';
    });
    outboxList = [];
    const before = listCalls.n;
    fireOutbox();
    await waitFor(() => expect(savePatch).toHaveBeenCalledTimes(2));
    await settle();
    expect(savePatch.mock.calls.map((c) => c[1])).toEqual([E1, E2]);
    // 再跑那一次待补写已经空了，不再读 outbox；之后也不会自己接着跑
    const reads = listCalls.n - before;
    expect(reads).toBe(1);
    await settle();
    expect(savePatch).toHaveBeenCalledTimes(2);
    expect(listCalls.n - before).toBe(reads);
  });
});
