// 今天页挂“麦克风被拒”的一行（Q-22，B3 S23）：放在“未同步”提示同一个 role="status" 容器里；没被拒时不画。
// 一行本身怎么判断、文案见 MicDeniedNote.test.tsx；这里只看今天页挂没挂、挂在哪
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';

let mic: 'denied' | 'granted' = 'denied';
vi.mock('../../../platform/perm-mic.ts', () => ({ lastMicResult: () => mic, micPermission: () => Promise.resolve(mic) }));
vi.mock('../../reminders/index.ts', () => ({
  MissedReminders: () => null,
  UnsyncedRemindHint: () => <p data-testid="fake-hint">未同步，提醒可能不响</p>,
  UnsyncedRemindMark: () => null,
}));
vi.mock('../ui/NowCard.tsx', () => ({ NowCard: () => <section data-testid="fake-now" /> }));
vi.mock('../hooks/useToday.ts', () => ({
  useToday: () => ({
    today: '2026-11-05', tz: 'Asia/Seoul', now: 0, card: null, tomorrowFirst: null,
    late: [], events: [], todos: [], toggleDone: async () => 'ok', remove: async () => 'ok',
  }),
}));

const { default: TodayPage } = await import('../ui/TodayPage.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
});

describe('今天页的麦克风被拒提示（Q-22）', () => {
  it('麦克风被拒：today-notice 容器里出“麦克风没有打开”一行，在“未同步”提示后面', async () => {
    mic = 'denied';
    render(<TodayPage />);
    const note = await screen.findByTestId('today-mic-denied');
    const notice = screen.getByTestId('today-notice');
    expect(note.parentElement).toBe(notice);
    expect(notice.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain('麦克风没有打开');
    expect(screen.getByTestId('fake-hint').compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('麦克风没被拒：不出这一行', async () => {
    mic = 'granted';
    render(<TodayPage />);
    await screen.findByTestId('fake-hint');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('today-mic-denied')).toBeNull();
  });
});
