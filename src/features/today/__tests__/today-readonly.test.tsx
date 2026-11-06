// 今天页的只读行（FA-2 只读行界面；架构 0.27 第 1 点、开发计划三之二）：
// • 顶部“有 N 条重复事项要新版本才能完整显示 · 更新”：只数还在用的、带 repeat 的只读行（日程 + 待办），没有时不画
// • 行尾“要新版本”标记；点这一行、打勾、删除统一拦下，出“这条要新版本才能修改 · 更新”
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections, collection, readonlyIds } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

type Row = { id: string } & Record<string, unknown>;

vi.mock('../../reminders/index.ts', () => ({ MissedReminders: () => null, UnsyncedRemindHint: () => null, UnsyncedRemindMark: () => null }));
vi.mock('../ui/NowCard.tsx', () => ({ NowCard: () => <section data-testid="fake-now" /> }));
const update = vi.fn(async () => undefined);
vi.mock('../../../platform/native-bridge.ts', async (orig) => ({ ...(await orig<object>()), requestAppUpdate: () => update() }));
const toggleDone = vi.fn(async () => 'ok' as const);
const remove = vi.fn(async () => 'ok' as const);
vi.mock('../hooks/useToday.ts', () => ({
  useToday: () => ({
    today: '2026-11-05', tz: 'Asia/Seoul', now: 0, card: null, tomorrowFirst: null,
    late: [{ todo: { id: 'l1', title: '交房租', dueTime: null }, days: 2 }],
    events: [{ id: 'e1', title: '每周例会', time: '10:00', origin: null }, { id: 'e2', title: '看牙', time: '15:00', origin: null }],
    todos: [{ id: 't1', title: '每天吃药', dueTime: null, done: false }],
    toggleDone, remove,
  }),
}));

const { default: TodayPage } = await import('../ui/TodayPage.tsx');

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  window.location.hash = '#/today';
  collection<Row>('events').upsert([
    { id: 'e1', repeat: { freq: 'week' }, deleted_at: null },
    { id: 'e2', deleted_at: null },
    { id: 'e3', repeat: { freq: 'day' }, deleted_at: 123 },   // 删掉的不算
  ]);
  collection<Row>('todos').upsert([{ id: 't1', repeat: { freq: 'day' }, deleted_at: null }, { id: 'l1', deleted_at: null }]);
  readonlyIds('events').set([{ id: 'e1', ro: true }, { id: 'e3', ro: true }]);
  readonlyIds('todos').set([{ id: 't1', ro: true }]);
  update.mockClear();
  toggleDone.mockClear();
  remove.mockClear();
});
afterEach(() => {
  cleanup();
  clearAllCollections();
});

describe('今天页的只读行', () => {
  it('顶部横幅：2 条（e1、t1；删掉的 e3 不算），在日期下面；点“更新”走 requestAppUpdate', async () => {
    render(<TodayPage />);
    const b = (await screen.findByTestId('today-repeat'));
    expect(b.textContent).toContain('有 2 条重复事项要新版本才能完整显示');
    expect(Boolean(screen.getByRole('heading', { level: 1 }).compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    await act(async () => {
      fireEvent.click((await screen.findByTestId('today-repeat-update')));
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('没有带重复的只读行：横幅不画', async () => {
    await act(async () => {
      readonlyIds('events').set([{ id: 'e1', ro: false }]);
      readonlyIds('todos').set([{ id: 't1', ro: false }]);
    });
    render(<TodayPage />);
    expect(screen.queryByTestId('today-repeat')).toBeNull();
  });

  it('只读的日程、待办行尾有标记；点了不进编辑页、出提示条；打勾和删除不写（× 是 aria-disabled）；可写的照常', async () => {
    render(<TodayPage />);
    expect((await screen.findByTestId('today-ro-e1'))).toBeTruthy();
    expect((await screen.findByTestId('today-ro-t1'))).toBeTruthy();
    expect(screen.queryByTestId('today-ro-e2')).toBeNull();
    expect(screen.queryByTestId('today-ro-l1')).toBeNull();
    fireEvent.click(screen.getByText('每周例会').closest('button') as HTMLButtonElement);
    expect(window.location.hash).toBe('#/today');
    expect((await screen.findByTestId('today-ro-toast')).textContent).toContain('这条要新版本才能修改');
    fireEvent.click(screen.getByTestId('today-done-t1'));
    // 只读行的 × 和打勾圆圈一样（FA-2 视觉验收第二轮第 1 条）：aria-disabled、读屏名字接“要更新到新版本才能修改”，点了拦下不写
    const x = screen.getByTestId('today-del-t1');
    expect(x.getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(x.getAttribute('aria-label')).toBe('删除，要更新到新版本才能修改'));
    fireEvent.click(x);
    expect(toggleDone).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('today-done-l1'));
    expect(toggleDone).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('看牙').closest('button') as HTMLButtonElement);
    expect(window.location.hash).toBe('#/event/e2');
  });
});
