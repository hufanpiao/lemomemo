// 待办子任务的界面（R-350 方案 5.1～5.5、6.1、6.2；TC-R350-01～09、14 的界面部分）：
// 列表页卡片（摊开的勾选清单、分段进度条、收起/展开、只读拦下、勾完最后一项自动完成 + 撤销条）、今天页一行进度、编辑页“子任务”区。
// 写入层（core/edit-save.ts）用替身记下每一笔，规则本身在 todo-items.test.ts
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections, collection, readonlyIds } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

const save = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../../core/edit-save.ts', async (orig) => ({
  ...(await orig<object>()),
  saveInsert: (...a: unknown[]) => (save.calls.push(['insert', ...a]), Promise.resolve('saved')),
  savePatch: (...a: unknown[]) => (save.calls.push(['patch', ...a]), Promise.resolve('saved')),
  saveDeleted: (...a: unknown[]) => (save.calls.push(['deleted', ...a]), Promise.resolve('saved')),
}));
const logs = vi.hoisted(() => [] as string[]);
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (m: string) => void logs.push(m) }));
vi.mock('../../reminders/index.ts', () => ({ UnsyncedRemindMark: () => null }));

const { default: TodosPage } = await import('../ui/TodosPage.tsx');
const { default: TodaySubtasks } = await import('../ui/TodaySubtasks.tsx');
const { default: SubtaskEditor } = await import('../ui/SubtaskEditor.tsx');
const { resetCollapsedForTest } = await import('../hooks/useSubtasks.ts');

const todo = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, done: false, important: false, project: '', due: null, due_time: null, deleted_at: null, ...over,
});
const item = (id: string, todoId: string, sort: number, done = false) => ({
  id, todo_id: todoId, title: `项${id}`, done, sort, created_at: 1, updated_at: 1, deleted_at: null,
});

beforeEach(() => {
  clearAllCollections();
  resetCollapsedForTest();
  uiStore.getState().setLocale('zh-CN');
  window.location.hash = '#/todos';
  save.calls = [];
  logs.length = 0;
  collection('todos').upsert([todo('t1', '买菜'), todo('t2', '回邮件'), todo('t3', '搬家', { done: true, done_at: 5 })]);
  collection('todo_items').upsert([item('a', 't1', 1, true), item('b', 't1', 2), item('c', 't1', 3), item('z', 't3', 1, true)]);
});
afterEach(() => {
  cleanup();
  clearAllCollections();
});

describe('列表页卡片（5.1、5.4、6.2）', () => {
  it('副行最前面是“已勾/总数”；进度条 role=progressbar 带总数、已勾、读屏句；没有子任务的行不画卡片', async () => {
    render(<TodosPage />);
    expect((await screen.findByTestId('todos-tag-t1')).textContent).toMatch(/^1\/3/);
    const bar = screen.getByTestId('todos-bar-t1');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect([bar.getAttribute('aria-valuemin'), bar.getAttribute('aria-valuemax'), bar.getAttribute('aria-valuenow')]).toEqual(['0', '3', '1']);
    expect(bar.getAttribute('aria-valuetext')).toBe('子任务已完成 1 项，共 3 项');
    expect(screen.queryByTestId('todos-subs-t2')).toBeNull();
    // 子任务勾选框的读屏名就是子任务标题
    expect(screen.getByTestId('todos-sub-b').getAttribute('aria-label')).toBe('项b');
  });

  it('未完成默认展开、已完成默认收起；收起按钮 aria-expanded、aria-controls，读屏名带待办标题；点了切换', async () => {
    render(<TodosPage />);
    const fold = await screen.findByTestId('todos-fold-t1');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(fold.getAttribute('aria-label')).toBe('收起「买菜」的子任务');
    const list = document.getElementById(fold.getAttribute('aria-controls') ?? '');
    expect(list?.hidden).toBe(false);
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.getAttribute('aria-label')).toBe('展开「买菜」的子任务');
    expect(list?.hidden).toBe(true);
    expect(screen.getByTestId('todos-fold-t3').getAttribute('aria-expanded')).toBe('false');
  });

  it('勾一项（没勾完）：只写子任务，主待办不动，不出撤销条', async () => {
    render(<TodosPage />);
    fireEvent.click(await screen.findByTestId('todos-sub-b'));
    await waitFor(() => expect(save.calls).toHaveLength(1));
    expect(save.calls[0]?.slice(0, 3)).toEqual(['patch', 'todo_items', 'b']);
    expect(screen.queryByTestId('todos-auto-toast')).toBeNull();
  });

  it('TC-R350-05、06：勾上最后一项 → 主待办自动完成、页底出“全部完成 · 撤销”；撤销时刚勾的那项和主待办一起撤回；运行日志只记事件', async () => {
    collection('todo_items').upsert([item('b', 't1', 2, true)]);
    render(<TodosPage />);
    fireEvent.click(await screen.findByTestId('todos-sub-c'));
    const toast = await screen.findByTestId('todos-auto-toast');
    expect(toast.textContent).toContain('全部完成，已完成这条待办');
    expect(save.calls.map((c) => c.slice(0, 3))).toEqual([['patch', 'todo_items', 'c'], ['patch', 'todos', 't1']]);
    expect(logs).toContain('todo sub auto done');
    save.calls = [];
    fireEvent.click(screen.getByText('撤销'));
    await waitFor(() => expect(save.calls).toHaveLength(2));
    expect(save.calls[0]?.slice(0, 4)).toEqual(['patch', 'todo_items', 'c', expect.objectContaining({ done: false })]);
    expect(save.calls[1]?.slice(0, 4)).toEqual(['patch', 'todos', 't1', expect.objectContaining({ done: false })]);
  });

  it('只读的子任务：勾了拦下出“要新版本”，不写', async () => {
    readonlyIds('todo_items').set([{ id: 'b', ro: true }]);
    render(<TodosPage />);
    fireEvent.click(await screen.findByTestId('todos-sub-b'));
    expect(await screen.findByText(/要更新到新版本才能修改|要新版本才能修改/)).toBeTruthy();
    expect(save.calls).toHaveLength(0);
  });
});

describe('今天页一行进度（5.2，Q5）', () => {
  it('有子任务：“1/3”加细进度条；没有子任务：什么都不画', () => {
    const { container } = render(
      <>
        <TodaySubtasks id="t1" />
        <TodaySubtasks id="t2" />
      </>,
    );
    const row = screen.getByTestId('today-subs-t1');
    // 看得见的“1/3”不进读屏；读屏读一句视觉隐藏的文字（这一行在今天页的按钮里，按钮里不放 progressbar）
    expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe('1/3');
    expect(row.textContent).toContain('子任务已完成 1 项，共 3 项');
    expect(row.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid^="today-subs-"]')).toHaveLength(1);
  });
});

/** 本机集合里主待办现在的行（编辑页传给子任务区的 todo） */
const rowOf = (id: string) => collection('todos').get(id) as unknown as Readonly<Record<string, unknown>>;

describe('编辑页“子任务”区（5.3、6.1）', () => {
  const t1 = () => rowOf('t1');

  it('新建页还没保存：添加框禁用，提示“写上标题才能加子任务”', () => {
    render(<SubtaskEditor todoId={null} todo={undefined} off={false} />);
    expect((screen.getByTestId('todo-sub-add') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('todo-sub-hint').textContent).toBe('写上标题才能加子任务');
  });

  it('回车加一项（去掉首尾空白、空的不加）；粘贴多行按行拆成多项', async () => {
    render(<SubtaskEditor todoId="t2" todo={rowOf('t2')} off={false} />);
    const add = screen.getByTestId('todo-sub-add') as HTMLInputElement;
    fireEvent.change(add, { target: { value: '   ' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(save.calls).toHaveLength(0);
    fireEvent.change(add, { target: { value: '  牛奶 ' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    await waitFor(() => expect(save.calls).toHaveLength(1));
    expect(save.calls[0]?.[2]).toEqual(expect.objectContaining({ todo_id: 't2', title: '牛奶', done: false }));
    expect(add.value).toBe('');
    fireEvent.paste(add, { clipboardData: { getData: () => '鸡蛋\n\n猫砂' } });
    await waitFor(() => expect(save.calls).toHaveLength(3));
    expect(save.calls.slice(1).map((c) => (c[2] as { title: string }).title)).toEqual(['鸡蛋', '猫砂']);
  });

  it('TC-R350-14：满 20 项添加框禁用、提示“最多 20 项”，运行日志记 todo items full；粘贴超出的条数记 dropped 并出红字', async () => {
    collection('todo_items').upsert(Array.from({ length: 19 }, (_, k) => item(`n${k}`, 't2', k + 1)));
    const { rerender } = render(<SubtaskEditor todoId="t2" todo={rowOf('t2')} off={false} />);
    fireEvent.paste(screen.getByTestId('todo-sub-add'), { clipboardData: { getData: () => '1\n2\n3' } });
    await waitFor(() => expect(save.calls).toHaveLength(1));
    expect(logs).toContain('todo items cap dropped=2');
    expect(screen.getByTestId('todo-sub-error').textContent).toBe('子任务最多 20 项，多出来的没有保存');
    act(() => collection('todo_items').upsert([item('n19', 't2', 20)]));
    rerender(<SubtaskEditor todoId="t2" todo={rowOf('t2')} off={false} />);
    expect((screen.getByTestId('todo-sub-add') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('todo-sub-hint').textContent).toBe('最多 20 项');
    expect(logs).toContain('todo items full');
  });

  it('删除：软删、出“已删除子任务 · 撤销”，撤销把 deleted_at 清回去', async () => {
    render(<SubtaskEditor todoId="t1" todo={t1()} off={false} />);
    fireEvent.click(screen.getByTestId('todo-sub-del-b'));
    const toast = await screen.findByTestId('todo-sub-deleted-toast');
    expect(toast.textContent).toContain('已删除子任务');
    expect(save.calls[0]?.slice(0, 3)).toEqual(['deleted', 'todo_items', 'b']);
    fireEvent.click(screen.getByText('撤销'));
    await waitFor(() => expect(save.calls).toHaveLength(2));
  });

  it('键盘排序：把手上 Alt + ↓ 挪一位（写排序键）；只读（off）时没有添加行、把手和 ×', () => {
    const { rerender } = render(<SubtaskEditor todoId="t1" todo={t1()} off={false} />);
    fireEvent.keyDown(screen.getByTestId('todo-sub-handle-a'), { key: 'ArrowDown', altKey: true });
    expect(save.calls[0]?.slice(0, 3)).toEqual(['patch', 'todo_items', 'a']);
    rerender(<SubtaskEditor todoId="t1" todo={t1()} off />);
    expect(screen.queryByTestId('todo-sub-add')).toBeNull();
    expect(screen.queryByTestId('todo-sub-handle-a')).toBeNull();
    expect(screen.queryByTestId('todo-sub-del-a')).toBeNull();
  });
});
