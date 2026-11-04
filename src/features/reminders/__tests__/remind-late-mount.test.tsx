// 首屏减重 ⑥：App 等页面画出来、浏览器空闲才挂 RemindHost，引擎挂得比打开晚。这里测引擎这一侧的三处兜底：
// • since 由 App 传进来：打开（since）到挂上之间到点的照样进横幅；不传时按挂载时刻算，这一条进“错过的提醒”
// • 挂上时先补写一次：挂上之前在整页提醒里只在本机了结的“知道了”，那条改动已经发出去了的，不等下一次 outbox 变化
// • 挂载时键盘已经弹着：先排队（holds 里有 keyboard）
// 替身和 RemindEngine.test.tsx、remind-later-ack.test.tsx 同一套
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
const savePatch = vi.fn(async (..._a: unknown[]): Promise<string> => 'saved');
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: (...a: unknown[]) => savePatch(...a) }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
let nowMs = 0;
const subs = new Set<() => void>();
vi.mock('../../../platform/clock.ts', () => ({
  clock: {
    now: () => nowMs,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    offset: () => 0,
    isClockWrong: () => false,
  },
}));
let kbOpen = false;
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined, isKeyboardOpen: () => kbOpen }));
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: async () => undefined,
  showLocalReminder: async () => undefined,
  closeLocalReminder: async () => undefined,
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: async () => 0 }));
vi.mock('../../../app/router.ts', () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: async () => undefined }));
type ObItem = { rec: string; op: 'insert' | 'patch'; state: 'pending' | 'inflight' | 'failed'; sent?: boolean; data: Record<string, unknown> };
let outboxList: ObItem[] = [];
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({
    outbox: { subscribe: () => () => undefined, getStatus: () => ({ remindRecs: new Set() }), list: async () => outboxList },
  }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');
const { useRemindActions, useRemindEngine, useReminderList } = await import('../hooks/useReminders.ts');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(DAY, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const E1 = '00000000-0000-4000-8000-000000000001';
const ev: Row = {
  id: E1, title: '和 Kim 开会', date: DAY, time: '15:30', tz: SEOUL, remind_min: 15, duration_min: 60,
  deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null,
};
const blocked: ObItem = { rec: `events:${E1}`, op: 'patch', state: 'pending', data: { date: DAY, remind_days: null, updated_at: 1 } };
/** 等异步跑完：排两轮宏任务（不数微任务次数） */
const settle = () => act(async () => {
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => setTimeout(r, 0));
});

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev];
  outboxList = [];
  kbOpen = false;
  subs.clear();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  savePatch.mockReset();
  savePatch.mockImplementation(async () => 'saved');
});
afterEach(() => cleanup());

describe('引擎晚挂（首屏减重 ⑥）', () => {
  it('since 由 App 传进来：打开到挂上之间到点的（15:15）照样进横幅', async () => {
    // 15:14 打开（App 记下 since），15:16 才挂上
    nowMs = at('15:16');
    render(<RemindHost route="todos" since={at('15:14')} />);
    expect(await screen.findByTestId('remind-banner')).toBeTruthy();
  });

  it('对照：不传 since 按挂载时刻算，挂上之前到点的不进横幅', async () => {
    nowMs = at('15:16');
    render(<RemindHost route="todos" />);
    await settle();
    expect(screen.queryByTestId('remind-banner')).toBeNull();
  });

  it('挂上时先补写一次：挂上之前只在本机了结的“知道了”，改动已经发出去了的，不等 outbox 通知就补写', async () => {
    nowMs = at('15:16');
    // 引擎还没挂（整页提醒页面里按“知道了”）：那条有没发出去的改动，只在本机了结
    const page = renderHook(() => ({ actions: useRemindActions(), list: useReminderList(nowMs).list }));
    outboxList = [blocked];
    await act(async () => {
      await page.result.current.actions.ackAll(page.result.current.list);
    });
    expect(savePatch).not.toHaveBeenCalled();
    // 那条改动发出去了，然后引擎才挂上；这个替身的 outbox 不发通知
    outboxList = [];
    renderHook(() => useRemindEngine(at('15:14')));
    await waitFor(() => expect(savePatch).toHaveBeenCalledTimes(1));
    expect(savePatch.mock.calls[0]?.[1]).toBe(E1);
  });

  it('挂载时键盘已经弹着：先排队（holds 里有 keyboard），横幅不出', async () => {
    kbOpen = true;
    nowMs = at('15:16');
    render(<RemindHost route="todos" since={at('15:14')} />);
    await settle();
    expect(remindQueue.getState().holds.map((h) => h.reason)).toEqual(['keyboard']);
    expect(screen.queryByTestId('remind-banner')).toBeNull();
  });
});
