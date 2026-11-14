// 今天页“已过去”折成一行（定稿线框 s1“已过去的折叠成一行”，时间河“▸ 已过去 2 件：10:30 SignPlex 字幕校对 · 买咖啡豆 ✓”；B6 对齐线框）：
// • 结束了的日程、做完的待办不在列表里，收成“已过去 N 件：时刻 标题 · 标题 ✓”一行；进行中、全天、还没到的、没做完的照常列
// • 点这一行展开（aria-expanded），过去的那几行排在最前面；再点收起；展开着变成 0 件时展开状态收回
// • 没有已过去的时候不画这一行
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

vi.mock('../../reminders/index.ts', () => ({ MissedReminders: () => null, UnsyncedRemindHint: () => null, UnsyncedRemindMark: () => null }));
vi.mock('../ui/NowCard.tsx', () => ({ NowCard: () => <section data-testid="fake-now" /> }));

const NOW = 1_000_000;
const ev = (id: string, title: string, time: string | null, end: number | null) => ({ id, title, time, end, origin: null });
const td = (id: string, title: string, done: boolean) => ({ id, title, dueTime: null, done });
const state = {
  events: [ev('e1', 'SignPlex 字幕校对', '10:30', NOW - 1), ev('e2', '团建', null, null), ev('e3', 'NEOX 横版对片', '13:00', NOW + 60_000)],
  todos: [td('t1', '回邮件', false), td('t2', '买咖啡豆', true)],
};
vi.mock('../hooks/useToday.ts', () => ({
  useToday: () => ({
    today: '2026-11-05', tz: 'Asia/Seoul', now: NOW, card: null, tomorrowFirst: null, late: [],
    events: state.events, todos: state.todos,
    toggleDone: async () => 'ok' as const, remove: async () => 'ok' as const,
  }),
}));

const { default: TodayPage } = await import('../ui/TodayPage.tsx');

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  window.location.hash = '#/today';
});
afterEach(() => {
  cleanup();
  clearAllCollections();
});

describe('今天页“已过去”折成一行', () => {
  it('结束了的日程、做完的待办收成一行；点了展开、再点收起', async () => {
    render(<TodayPage />);
    const list = screen.getByTestId('today-list');
    const fold = within(list).getByTestId('today-past');
    expect(fold.textContent).toContain('已过去 2 件：10:30 SignPlex 字幕校对 · 买咖啡豆 ✓');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    // 收起时：过去的那两行不在列表里，进行中 / 全天 / 没做完的照常
    expect(screen.queryByTestId('today-event-e1')).toBeNull();
    expect(screen.queryByTestId('today-todo-t2')).toBeNull();
    for (const id of ['today-event-e2', 'today-event-e3', 'today-todo-t1']) expect(screen.getByTestId(id)).toBeTruthy();
    // 这一行在列表上面
    expect(Boolean(fold.compareDocumentPosition(screen.getByTestId('today-event-e2')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    await act(async () => {
      fireEvent.click(fold);
    });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const rows = [...list.querySelectorAll('li[data-testid]')].map((li) => li.getAttribute('data-testid'));
    expect(rows.slice(0, 2)).toEqual(['today-event-e1', 'today-todo-t2']);

    await act(async () => {
      fireEvent.click(fold);
    });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
  });

  it('展开着变成 0 件：展开状态收回，再有已过去的时照收起画', async () => {
    const keep = { ...state };
    try {
      const { rerender } = render(<TodayPage />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('today-past'));
      });
      expect(screen.getByTestId('today-past').getAttribute('aria-expanded')).toBe('true');
      state.events = [ev('e3', 'NEOX 横版对片', '13:00', NOW + 60_000)];
      state.todos = [td('t1', '回邮件', false)];
      rerender(<TodayPage />);
      expect(screen.queryByTestId('today-past')).toBeNull();
      state.events = keep.events;
      state.todos = keep.todos;
      rerender(<TodayPage />);
      expect(screen.getByTestId('today-past').getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByTestId('today-event-e1')).toBeNull();
    } finally {
      state.events = keep.events;
      state.todos = keep.todos;
    }
  });

  it('没有已过去的：不画这一行', () => {
    const keep = { ...state };
    state.events = [ev('e3', 'NEOX 横版对片', '13:00', NOW + 60_000)];
    state.todos = [td('t1', '回邮件', false)];
    try {
      render(<TodayPage />);
      expect(screen.queryByTestId('today-past')).toBeNull();
      expect(screen.getByTestId('today-event-e3')).toBeTruthy();
    } finally {
      state.events = keep.events;
      state.todos = keep.todos;
    }
  });
});
