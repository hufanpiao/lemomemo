// 换账号以后 rangSnapshot() 是空的（REMIND-wiring、第二轮 L8）：App 把 RemindHost 按 user_id 作 key 挂，换账号整个重新挂载；
// 这里直接换 key，确认引擎卸载时清掉了模块级的“本次打开响过的”，新账号的 RemindHost 拿到的是空的。替身和 RemindEngine.test.tsx 同一套
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindQueue, resetRemindQueue } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [], settings: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
vi.mock('../../../core/edit-save.ts', () => ({ savePatch: async () => 'saved' }));
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
vi.mock('../../../platform/viewport.ts', () => ({ watchKeyboard: () => () => undefined }));
vi.mock('../../../platform/native-bridge.ts', () => ({
  openReminder: async () => undefined,
  showLocalReminder: async () => undefined,
  closeLocalReminder: async () => undefined,
}));
vi.mock('../../../platform/notifications.ts', () => ({ closeHandledNotifications: async () => 0 }));
vi.mock('../../../app/router.ts', () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: async () => undefined }));
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ remindRecs: new Set() }), list: async () => [] } }),
}));

const { default: RemindHost } = await import('../ui/RemindHost.tsx');
const { rangSnapshot } = await import('../hooks/useReminders.ts');

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(DAY, (h ?? 0) * 60 + (m ?? 0), SEOUL);
};
const ev: Row = {
  id: '00000000-0000-4000-8000-000000000001', title: '和 Kim 开会', date: DAY, time: '15:30', tz: SEOUL, remind_min: 15, duration_min: 60,
  deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null,
};
const tick = (hm: string): void => {
  nowMs = at(hm);
  act(() => {
    for (const f of [...subs]) f();
  });
};

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  data.events = [ev];
  nowMs = at('15:00');
  resetRemindQueue();
  remindQueue.setState({ holds: [] });
});
afterEach(() => cleanup());

describe('换账号重新挂载 RemindHost（L8）', () => {
  it('响过一条以后换 key：rangSnapshot() 清空', async () => {
    const { rerender } = render(<RemindHost key="user-a" route="todos" />);
    tick('15:16');
    await screen.findByTestId('remind-banner');
    expect(rangSnapshot().size).toBe(1);
    // 换账号：新账号没有这一条
    data.events = [];
    rerender(<RemindHost key="user-b" route="todos" />);
    expect(rangSnapshot().size).toBe(0);
  });
});
