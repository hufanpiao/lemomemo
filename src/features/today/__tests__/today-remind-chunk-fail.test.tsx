// 今天页提醒那几块的分包下不来（离线、发版后旧分包没了）：今天页外面包了 kit 的 QuietBoundary，
// 那几块空着，日程、待办照常显示，整页不换成出错页（今天页待办 代码审查 M1 附带）
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRemindArmed, setRemindDown } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

vi.mock('../../reminders/index.ts', async () => {
  const { lazy } = await import('react');
  const fail = () => lazy(() => Promise.reject(new Error('chunk load failed')));
  return { MissedReminders: fail(), UnsyncedRemindHint: fail(), UnsyncedRemindMark: fail() };
});
vi.mock('../ui/NowCard.tsx', () => ({ NowCard: () => <section data-testid="fake-now" /> }));
vi.mock('../hooks/useToday.ts', () => ({
  useToday: () => ({
    today: '2026-11-05', tz: 'Asia/Seoul', now: 0, card: null, tomorrowFirst: null,
    late: [],
    events: [{ id: 'e1', title: '客户周会', time: '10:00', origin: null }],
    todos: [{ id: 't1', title: '回邮件', dueTime: '15:00', done: false }],
    toggleDone: async () => 'ok', remove: async () => 'ok',
  }),
}));

const { default: TodayPage } = await import('../ui/TodayPage.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  setRemindArmed(null);
  setRemindDown(false);
  vi.restoreAllMocks();
});

describe('提醒分包下不来', () => {
  // 审查“错过提醒推迟挂载”M2：今天页等引擎 armed（或出错）才挂“错过的提醒”，两种都试：armed 了、分包下不来；引擎坏了（remindDown）、分包也下不来（离线）
  it.each([
    ['引擎 armed', () => setRemindArmed(1)],
    ['引擎出错（remindDown）', () => setRemindDown(true)],
  ])('%s：错过（容器在、里面没有按钮）、提示、行尾标记都空着；日程、待办照常', async (_name, arm) => {
    arm();
    render(<TodayPage />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('客户周会')).toBeTruthy();
    expect(screen.getByText('回邮件')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByTestId('today-notice').textContent).toBe('');
    const missed = screen.getByTestId('today-missed');
    expect(missed.querySelector('button')).toBeNull();
  });
});
