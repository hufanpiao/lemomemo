// 今天页上提醒的几块（REMIND-wiring、REMIND-missed-flash）：“错过的提醒”在引擎 armed 了（armedSince；打开时刻 openedAt 已删，
// REMIND-shown-persist 修订 1 P2）或者出错了（remindDown；代码审查 M1）时挂；“未同步”提示和行尾标记和引擎无关，直接挂；
// 位置：日期下面、“现在”卡上面（线框 MISSROW）；“未同步”提示外面是常驻的 role="status" 空容器；行尾标记在行按钮里、标题右边。
// reminders 的 index.ts 用替身（这里只看今天页怎么挂；错过的提醒自己怎么算在 reminders 的测试里）
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRemindArmed, setRemindDown } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

let recs = new Set<string>();
const FakeMissed = () => <div data-testid="fake-missed">错过 1 条提醒</div>;
vi.mock('../../reminders/index.ts', () => ({
  MissedReminders: FakeMissed,
  UnsyncedRemindHint: () => (recs.size > 0 ? <p data-testid="fake-hint">未同步，提醒可能不响</p> : null),
  UnsyncedRemindMark: ({ table, id }: { table: string; id: string }) =>
    recs.has(`${table}:${id}`) ? <span data-testid="fake-mark">未同步</span> : null,
}));
vi.mock('../ui/NowCard.tsx', () => ({ NowCard: () => <section data-testid="fake-now" /> }));
vi.mock('../hooks/useToday.ts', () => ({
  useToday: () => ({
    today: '2026-11-05', tz: 'Asia/Seoul', now: 0, card: null, tomorrowFirst: null,
    late: [{ todo: { id: 'l1', title: '交房租', dueTime: null }, days: 2 }],
    events: [{ id: 'e1', title: '客户周会', time: '10:00', origin: null }],
    todos: [{ id: 't1', title: '回邮件', dueTime: '15:00', done: false }],
    toggleDone: async () => 'ok', remove: async () => 'ok',
  }),
}));

const { default: TodayPage } = await import('../ui/TodayPage.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  recs = new Set(['events:e1', 'todos:l1']);
  setRemindArmed(null);
  setRemindDown(false);
});
afterEach(() => {
  cleanup();
  setRemindArmed(null);
  setRemindDown(false);
});

const follows = (a: Element, b: Element): boolean => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('引擎还没有结果', () => {
  it('“错过的提醒”不挂；未同步提示、行尾标记不等引擎，直接挂（同日历页，M1）', async () => {
    render(<TodayPage />);
    expect(screen.queryByTestId('fake-missed')).toBeNull();
    const notice = screen.getByTestId('today-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect((await screen.findByTestId('fake-hint')).parentElement).toBe(notice);
    expect(screen.getAllByTestId('fake-mark')).toHaveLength(2);
  });
});

describe('等引擎 armed（原 J1 的“一打开就挂”，修订 1 P2 改成等 armed）', () => {
  it('还没 armed：不挂（分包不进首屏）；armed 了才挂，位置同前；清掉（换账号）就撤', async () => {
    render(<TodayPage />);
    expect(screen.queryByTestId('fake-missed')).toBeNull();
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(screen.queryByTestId('fake-missed')).toBeNull();
    await act(async () => {
      setRemindArmed(1);
    });
    const missed = await screen.findByTestId('fake-missed');
    expect(follows(screen.getByRole('heading', { level: 1 }), missed)).toBe(true);
    expect(follows(missed, screen.getByTestId('today-notice'))).toBe(true);
    expect(missed.closest('[data-testid="today-missed"]')).toBeTruthy();
    await act(async () => {
      setRemindArmed(null);
    });
    expect(screen.queryByTestId('fake-missed')).toBeNull();
  });
});

describe('引擎出错（M1）', () => {
  it('RemindHost 挂不上（kit 的 remindDown）：今天页照样挂“错过的提醒”，位置同挂上时；提示、标记照旧', async () => {
    render(<TodayPage />);
    await act(async () => {
      setRemindDown(true);
    });
    const missed = await screen.findByTestId('fake-missed');
    expect(follows(screen.getByRole('heading', { level: 1 }), missed)).toBe(true);
    expect(follows(missed, screen.getByTestId('today-notice'))).toBe(true);
    expect(screen.getByTestId('fake-hint')).toBeTruthy();
    expect(screen.getAllByTestId('fake-mark')).toHaveLength(2);
    // 换账号（那一份提醒卸载，remindDown 清掉）：撤掉，等新账号的引擎
    await act(async () => {
      setRemindDown(false);
    });
    expect(screen.queryByTestId('fake-missed')).toBeNull();
  });
});

describe('引擎挂上以后', () => {
  it('“错过的提醒”在日期下面、“现在”卡上面；提示装进同一个 status 容器（同一个节点，后填进去）', async () => {
    render(<TodayPage />);
    const notice = screen.getByTestId('today-notice');
    await act(async () => {
      setRemindArmed(1);
    });
    const missed = await screen.findByTestId('fake-missed');
    const hint = await screen.findByTestId('fake-hint');
    expect(screen.getByTestId('today-notice')).toBe(notice);
    expect(hint.parentElement).toBe(notice);
    const h1 = screen.getByRole('heading', { level: 1 });
    const now = screen.getByTestId('fake-now');
    expect(follows(h1, missed)).toBe(true);
    expect(follows(missed, notice)).toBe(true);
    expect(follows(notice, now)).toBe(true);
  });

  it('行尾标记：只标没同步上的（日程按 events、待办按 todos，没赶上的也标），在行按钮里、是最后一个；其余行那一格空着', async () => {
    render(<TodayPage />);
    await act(async () => {
      setRemindArmed(1);
    });
    await screen.findAllByTestId('fake-mark');
    expect(screen.getAllByTestId('fake-mark')).toHaveLength(2);
    const btnOf = (title: string) => screen.getByText(title).closest('button') as HTMLButtonElement;
    for (const title of ['客户周会', '交房租']) {
      const b = btnOf(title);
      expect(within(b).getByTestId('fake-mark')).toBeTruthy();
      expect(b.lastElementChild?.contains(within(b).getByTestId('fake-mark'))).toBe(true);
      expect(b.textContent).toContain('未同步');
    }
    const plain = btnOf('回邮件').lastElementChild as HTMLElement;
    expect(plain.className).toContain('unsynced');
    expect(plain.childNodes).toHaveLength(0);
  });

  it('待办行尾没有 ×（负责人 11-15“代办后面的x去掉”）：待办行包在左滑行里（kit SwipeRow，删除按钮收着时 inert）；日程行不再补和 × 同宽的空格子，行尾就是行按钮', () => {
    const { container } = render(<TodayPage />);
    const evRows = [...container.querySelectorAll<HTMLElement>('[data-testid^="today-event-"]')];
    const tdRows = [...container.querySelectorAll<HTMLElement>('[data-testid^="today-todo-"]')];
    expect(evRows.length).toBeGreaterThan(0);
    expect(tdRows.length).toBeGreaterThan(0);
    for (const row of evRows) {
      expect(row.lastElementChild?.tagName).toBe('BUTTON');
      expect(row.querySelector('[data-testid^="today-del-"]')).toBeNull();
    }
    for (const row of tdRows) {
      const id = (row.dataset['testid'] ?? '').replace('today-todo-', '');
      expect(row.querySelector(`[data-testid="today-swipe-${id}"]`)).not.toBeNull();
      expect(row.querySelector(`[data-testid="today-del-${id}"]`)).toBeNull();
      expect(row.querySelector(`[data-testid="today-swipe-del-${id}"]`)?.closest('[inert]')).not.toBeNull();
    }
  });

  it('引擎卸载（退出登录、换账号）：“错过的提醒”跟着撤掉；提示、标记和引擎无关，照旧', async () => {
    render(<TodayPage />);
    await act(async () => {
      setRemindArmed(1);
    });
    await screen.findByTestId('fake-missed');
    await act(async () => {
      setRemindArmed(null);
    });
    expect(screen.queryByTestId('fake-missed')).toBeNull();
    expect(screen.getAllByTestId('fake-mark')).toHaveLength(2);
    expect(screen.getByTestId('fake-hint')).toBeTruthy();
  });
});
