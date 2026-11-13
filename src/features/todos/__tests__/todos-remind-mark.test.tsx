// 待办列表行尾“未同步”小标记（REMIND-wiring；TC-B2-69）：和提醒引擎无关、直接挂（今天页待办 代码审查 M1，同日历页）；只标没同步上的那条（todos 表），
// 在行按钮里、是最后一个。reminders 的 index.ts 用替身（标记自己怎么判断在 reminders 的测试里）
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRemindArmed, setRemindDown } from '../../../kit/state/remind-queue.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as ListMod from '../hooks/useTodoList.ts';

let recs = new Set<string>();
vi.mock('../../reminders/index.ts', () => ({
  UnsyncedRemindMark: ({ table, id }: { table: string; id: string }) =>
    recs.has(`${table}:${id}`) ? <span data-testid="fake-mark">未同步</span> : null,
}));
const todo = (id: string, title: string) => ({ id, title, done: false, important: false, project: '', due: '2026-11-05', dueTime: '15:00' });
vi.mock('../hooks/useTodoList.ts', async (orig) => ({
  ...(await orig<typeof ListMod>()),
  useTodoList: () => ({
    groups: [
      { key: 'today', date: null, items: [{ todo: todo('t1', '回邮件'), tag: { kind: 'today', dueTime: '15:00' } }, { todo: todo('t2', '交房租'), tag: { kind: 'today', dueTime: null } }] },
    ],
    projects: [], project: null, setProject: () => undefined, toggleDone: async () => 'ok', remove: async () => 'ok', total: 2,
    subs: new Map(),   // R-350：没有子任务
  }),
}));

const { default: TodosPage } = await import('../ui/TodosPage.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  recs = new Set(['todos:t1', 'events:t2']);
  setRemindArmed(null);
});
afterEach(() => {
  cleanup();
  setRemindArmed(null);
  setRemindDown(false);
});

const btnOf = (title: string) => screen.getByText(title).closest('button') as HTMLButtonElement;

describe('待办列表行尾“未同步”小标记', () => {
  it('不等引擎：只标 todos 表里没同步上的那条（events 表同 id 的不算），在行按钮里、是最后一个，读屏名带上“未同步”；其余行那一格空着', async () => {
    render(<TodosPage />);
    await screen.findByTestId('fake-mark');
    expect(screen.getAllByTestId('fake-mark')).toHaveLength(1);
    const b = btnOf('回邮件');
    expect(b.lastElementChild?.contains(within(b).getByTestId('fake-mark'))).toBe(true);
    expect(b.textContent).toContain('未同步');
    const other = btnOf('交房租').lastElementChild as HTMLElement;
    expect(other.className).toContain('unsynced');
    expect(other.childNodes).toHaveLength(0);
  });

  it('引擎挂上、卸载、出错都不影响标记', async () => {
    render(<TodosPage />);
    await screen.findByTestId('fake-mark');
    for (const f of [() => setRemindArmed(1), () => setRemindArmed(null), () => setRemindDown(true)]) {
      await act(async () => {
        f();
      });
      expect(screen.getAllByTestId('fake-mark')).toHaveLength(1);
    }
  });
});
