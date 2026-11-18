// 冷启动第一次进待办：子任务收起状态（本机 meta ui.todo_collapsed）读回来以前列表不画，第一次画出来就是记着的收起样子
// （负责人 11-18 录屏“冷启动第一次进待办的时候下面的一部分待办飞上来”：原来先按默认“未完成展开”画、读到“已收起”再缩回，下面的行跟着播挪位动画）
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

const meta = vi.hoisted(() => ({ open: null as ((v: unknown) => void) | null, reads: 0 }));
vi.mock('../../../core/boot.ts', async (orig) => ({
  ...(await orig<object>()),
  getBoot: () => ({
    cache: {
      isClosed: () => false,
      getMeta: (k: string) => {
        meta.reads += 1;
        if (k !== 'ui.todo_collapsed') return Promise.resolve(undefined);
        return new Promise((r) => (meta.open = r));
      },
      setMeta: () => Promise.resolve(),
    },
  }),
}));
vi.mock('../../reminders/index.ts', () => ({ UnsyncedRemindMark: () => null }));

const { default: TodosPage } = await import('../ui/TodosPage.tsx');
const { resetCollapsedForTest } = await import('../hooks/useSubtasks.ts');

const todo = (id: string, title: string) => ({ id, title, done: false, important: false, project: '', due: null, due_time: null, deleted_at: null });
const item = (id: string, todoId: string, sort: number) => ({ id, todo_id: todoId, title: `项${id}`, done: false, sort, created_at: 1, updated_at: 1, deleted_at: null });

beforeEach(() => {
  clearAllCollections();
  resetCollapsedForTest();
  meta.open = null;
  meta.reads = 0;
  uiStore.getState().setLocale('zh-CN');
  window.location.hash = '#/todos';
  collection('todos').upsert([todo('t1', '去超市'), todo('t2', '剪头发')]);
  collection('todo_items').upsert([item('a', 't1', 1), item('b', 't1', 2), item('c', 't1', 3)]);
});
afterEach(() => {
  cleanup();
  clearAllCollections();
});

describe('待办页等子任务收起状态读好再画', () => {
  it('读回来以前一行都不画（不先按默认摊开）；读到“去超市已收起”以后第一次画出来就是收起的', async () => {
    render(<TodosPage />);
    await act(async () => undefined);
    expect(meta.reads, '去读了本机那份').toBeGreaterThan(0);
    expect(screen.queryByTestId('todos-fold-t1'), '还没读好：不画').toBeNull();
    expect(screen.queryByText('剪头发')).toBeNull();
    await act(async () => meta.open?.({ t1: true }));
    const fold = await screen.findByTestId('todos-fold-t1');
    expect(fold.textContent).toBe('展开');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('剪头发')).toBeTruthy();
  });
});
