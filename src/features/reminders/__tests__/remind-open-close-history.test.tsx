// 在 App 里打开整页提醒再关掉，回到原来那一页（R-372 代码审 M1，负责人选 ①“其他页左滑回今天”）：
// 横幅、错过的提醒都走 ui/open-reminder.ts：网页版在 /app/ 里走路由压一条带本次编号的历史，关掉时退一步；
// 不再直接改 location.hash（压的历史不带编号，关掉时只能原地换成今天，今天下面留着打开前那一页，在今天左滑又回到那一页）。
// 路由、桥都用真的；本机集合、写入、时钟、键盘的替身和 RemindViews.test.tsx 同一套
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { canGoBack, navigateTab, resetLoadForTest, useRoute } from '../../../app/router.ts';
import { openReminder } from '../ui/open-reminder.ts';
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
const savePatch = vi.fn(async (..._a: unknown[]) => 'saved' as const);
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
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined, isKeyboardOpen: () => false }));
const closeHandled = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: (...a: unknown[]) => closeHandled(...a) }));
let remindRecs: ReadonlySet<string> = new Set();
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs }) } }),
}));

const { default: FullReminderPage } = await import('../ui/FullReminderPage.tsx');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string, date = DAY): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const E1 = '00000000-0000-4000-8000-000000000001';
const E2 = '00000000-0000-4000-8000-000000000002';
const ev = (id: string, title: string, time: string, over: Record<string, unknown> = {}): Row => ({
  id, title, date: DAY, time, tz: SEOUL, remind_min: 15, duration_min: 60, deleted_at: null, undone: false,
  notified_for: null, snooze_at: null, defer_until: null, ...over,
});

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev(E1, '和 Kim 开会', '15:30'), ev(E2, '牙医', '15:45')];
  data.todos = [];
  data.settings = [];
  nowMs = at('15:00');
  remindRecs = new Set();
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
  for (const f of [savePatch, closeHandled]) f.mockClear();
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});




/** App 订阅路由（载入时记下第一页） */
function RouteProbe() {
  useRoute();
  return null;
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
let base = 0;

describe('打开整页提醒再关掉：回到原来那一页（R-372 代码审 M1）', () => {
  beforeEach(() => {
    resetLoadForTest();
    window.history.pushState(null, '', '/app/#/today'); // 进 App 的第一页；push 截掉别的用例留下的“前进”历史
    base = window.history.length;
    nowMs = at('15:16');
  });

  it('日历点横幅进整页提醒，关掉回到日历；日历还能左滑回今天', async () => {
    render(<RouteProbe />);
    navigateTab('calendar');
    await flush();
    await openReminder('event', E1, at('15:15'));
    expect(window.location.hash).toBe(`#/remind/event/${E1}?due=${at('15:15')}`);
    expect(window.history.length).toBe(base + 2);
    render(<FullReminderPage />);
    fireEvent.click(screen.getByTestId('remind-full-back'));
    await vi.waitFor(() => expect(window.location.hash).toBe('#/calendar'));
    expect(canGoBack()).toBe(true);
    window.history.back();
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
  });

  it('今天点进整页提醒，关掉回今天；今天下面没有日历（在今天左滑不会退到日历）', async () => {
    render(<RouteProbe />);
    navigateTab('calendar');
    await flush();
    navigateTab('today'); // 退一步回今天，日历成了“前进”那一条
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    await openReminder('event', E1, at('15:15')); // 截掉“前进”的日历，压一条整页提醒
    expect(window.history.length).toBe(base + 1);
    render(<FullReminderPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('remind-full-back'));
    });
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    await flush();
    expect(canGoBack()).toBe(false); // 今天是根：没有 App 里的上一页
    expect(window.history.length).toBe(base + 1);
  });
});
