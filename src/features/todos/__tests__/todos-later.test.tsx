// 过期没做完的行尾“推迟”（负责人 11-21“没赶上的加一个推迟按钮，按一下把时间推迟到明天”）：只在过期没做完的行出；
// 按一下截止日改成明天（current_tz）、不进编辑页、出“已推迟到明天 · 撤销”，撤销写回原来的截止日；只读行拦下；按钮上按下不起左滑
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, todayOf } from '../../../../shared/core/date.ts';
import { clearAllCollections, collection, readonlyIds } from '../../../core/store.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

vi.mock('../../reminders/index.ts', () => ({ UnsyncedRemindMark: () => null }));
type Row = Record<string, unknown> & { id: string };
// 写入换成桩：直接改本机集合（真的写入经 outbox，单测在 core/__tests__/todo-writes.test.ts）
const setDue = vi.fn(async (r: Row, due: string) => {
  collection('todos').upsert([Object.assign({}, r, { due })]);
  return 'saved' as const;
});
vi.mock('../../../core/todo-writes.ts', async (orig) => ({
  ...(await orig<object>()),
  setTodoDue: (r: Row, due: string) => setDue(r, due),
}));

const { default: TodosPage } = await import('../ui/TodosPage.tsx');

const today = todayOf(Date.now(), currentTz());
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);
const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, done: false, important: false, project: '', due: yesterday, due_time: '17:00', remind_before_min: 60, deleted_at: null, ...over,
});

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  window.location.hash = '#/todos';
  collection('todos').upsert([
    row('late1', '交报告'),
    row('soon1', '买菜', { due: tomorrow }),
    row('done1', '倒垃圾', { done: true }),
    row('ro1', '每周例会', { repeat: { freq: 'week' } }),
  ]);
  readonlyIds('todos').set([{ id: 'ro1', ro: true }]);
  setDue.mockClear();
});
afterEach(() => {
  cleanup();
  clearAllCollections();
});

describe('过期待办的“推迟”', () => {
  it('只在过期没做完的行出（读屏“推迟到明天：标题”）；没过期的、做完的不出', async () => {
    render(<TodosPage />);
    const b = await screen.findByTestId('todos-later-late1');
    expect(b.textContent).toBe('推迟');
    expect(b.getAttribute('aria-label')).toBe('推迟到明天：交报告');
    expect(screen.queryByTestId('todos-later-soon1')).toBeNull();
    expect(screen.queryByTestId('todos-later-done1')).toBeNull();
  });

  it('过期没做完的行只出“推迟”、不出 H / M / L；推迟以后 H / M / L 回来（负责人 11-21）', async () => {
    render(<TodosPage />);
    await screen.findByTestId('todos-later-late1');
    expect(screen.queryByTestId('todos-prio-late1')).toBeNull();
    expect(screen.getByTestId('todos-prio-soon1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('todos-later-late1'));
    await vi.waitFor(() => expect(screen.queryByTestId('todos-later-late1')).toBeNull());
    expect(screen.getByTestId('todos-prio-late1')).toBeTruthy();
  });

  it('按一下：截止日改成明天，不进编辑页；行不再过期、按钮消失；出“已推迟到明天 · 撤销”，撤销写回原来的截止日', async () => {
    render(<TodosPage />);
    fireEvent.click(await screen.findByTestId('todos-later-late1'));
    await vi.waitFor(() => expect(setDue).toHaveBeenCalledTimes(1));
    expect(setDue.mock.calls[0]?.[1]).toBe(tomorrow);
    expect(window.location.hash).toBe('#/todos');
    const toast = await screen.findByTestId('todos-later-toast');
    expect(toast.textContent).toContain('已推迟到明天');
    await vi.waitFor(() => expect(screen.queryByTestId('todos-later-late1')).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId('todos-later-toast-undo'));
    });
    await vi.waitFor(() => expect(setDue).toHaveBeenCalledTimes(2));
    expect(setDue.mock.calls[1]?.[0]['due']).toBe(tomorrow);
    expect(setDue.mock.calls[1]?.[1]).toBe(yesterday);
    expect(await screen.findByTestId('todos-later-late1')).toBeTruthy();
  });

  it('只读行（重复待办本版只读）：拦下出“要新版本”，不写', async () => {
    render(<TodosPage />);
    fireEvent.click(await screen.findByTestId('todos-later-ro1'));
    expect(await screen.findByTestId('todos-ro-toast')).toBeTruthy();
    expect(setDue).not.toHaveBeenCalled();
  });

  it('在按钮上按下横滑：不起左滑（行面收不到这一下按下）', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-swipe-face') ? 360 : 72;
    });
    HTMLElement.prototype.setPointerCapture = () => undefined;
    render(<TodosPage />);
    const b = await screen.findByTestId('todos-later-late1');
    fireEvent.pointerDown(b, { pointerId: 1, isPrimary: true, clientX: 300, clientY: 20, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(b, { pointerId: 1, isPrimary: true, clientX: 270, clientY: 20, pointerType: 'touch' });
    fireEvent.pointerMove(b, { pointerId: 1, isPrimary: true, clientX: 240, clientY: 20, pointerType: 'touch' });
    fireEvent.pointerUp(b, { pointerId: 1, isPrimary: true, clientX: 240, clientY: 20, pointerType: 'touch' });
    expect(screen.getByTestId('todos-swipe-late1').getAttribute('data-swipe')).toBeNull();
    vi.restoreAllMocks();
  });
});
