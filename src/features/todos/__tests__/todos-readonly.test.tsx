// 待办列表的只读行（FA-2 只读行界面；架构 0.27 第 1 点）：行尾“要新版本”标记；点这一行、打勾、删除统一拦下（不进编辑页、不写），
// 出“这条要新版本才能修改 · 更新”，“更新”走 requestAppUpdate；可写的行照常
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections, collection, readonlyIds } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

vi.mock('../../reminders/index.ts', () => ({ UnsyncedRemindMark: () => null }));
const update = vi.fn(async () => undefined);
vi.mock('../../../platform/native-bridge.ts', async (orig) => ({ ...(await orig<object>()), requestAppUpdate: () => update() }));
const setDone = vi.fn(async () => 'saved' as const);
const setDeleted = vi.fn(async () => 'saved' as const);
vi.mock('../../../core/todo-done.ts', async (orig) => ({ ...(await orig<object>()), doneToggler: () => () => setDone() }));
vi.mock('../data/todo-actions.ts', async (orig) => ({ ...(await orig<object>()), setTodoDeleted: () => setDeleted() }));

const { default: TodosPage } = await import('../ui/TodosPage.tsx');

const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, done: false, important: false, project: '', due: null, due_time: null, deleted_at: null, ...over,
});

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  window.location.hash = '#/todos';
  collection('todos').upsert([row('ro1', '每周倒垃圾', { repeat: { freq: 'week' } }), row('ok1', '回邮件')]);
  readonlyIds('todos').set([{ id: 'ro1', ro: true }]);
  update.mockClear();
  setDone.mockClear();
  setDeleted.mockClear();
});
afterEach(() => {
  cleanup();
  clearAllCollections();
});

const titleBtn = (title: string) => screen.getByText(title).closest('button') as HTMLButtonElement;

describe('待办页顶栏（R-381）', () => {
  it('“待办”标题右端是设置入口头像，和今天页、随手记页同一个组件', async () => {
    render(<TodosPage />);
    const me = await screen.findByTestId('todos-settings');
    expect(me.getAttribute('href')).toContain('#/settings');
    expect(me.getAttribute('aria-label')).toBe('设置');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(me.parentElement).toBe(h1.parentElement);
    expect(h1.parentElement?.lastElementChild).toBe(me);
  });
});

describe('待办列表的只读行', () => {
  it('只读行行尾有“要新版本”标记（读屏读整句），圆圈 aria-disabled；可写的行没有', async () => {
    render(<TodosPage />);
    const mark = (await screen.findByTestId('todos-ro-ro1'));
    expect(titleBtn('每周倒垃圾').contains(mark)).toBe(true);
    expect(mark.textContent).toContain('要更新到新版本才能修改');
    expect(screen.queryByTestId('todos-ro-ok1')).toBeNull();
    expect(screen.getByTestId('todos-done-ro1').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('todos-done-ok1').hasAttribute('aria-disabled')).toBe(false);
    // 读屏名字后接“要更新到新版本才能修改”（FA-2 审查第 5 条）；可写的行不接
    expect(screen.getByTestId('todos-done-ro1').getAttribute('aria-label')).toBe('完成，要更新到新版本才能修改');
    expect(screen.getByTestId('todos-done-ok1').getAttribute('aria-label')).not.toContain('新版本');
    expect(screen.getByTestId('todos-row-ro1').hasAttribute('data-readonly')).toBe(true);
  });

  it('点这一行：不进编辑页，出“这条要新版本才能修改 · 更新”；点“更新”走 requestAppUpdate', async () => {
    render(<TodosPage />);
    fireEvent.click(titleBtn('每周倒垃圾'));
    expect(window.location.hash).toBe('#/todos');
    const toast = await screen.findByTestId('todos-ro-toast');
    expect(toast.textContent).toContain('这条要新版本才能修改');
    // 每次拦下新挂一条：用 alert（新挂的 status 区域 iOS VoiceOver 常常不读；FA-2 审查第 1 条）
    expect(toast.getAttribute('role')).toBe('alert');
    expect(screen.getByRole('alert').textContent).toContain('这条要新版本才能修改');
    await act(async () => {
      fireEvent.click((await screen.findByTestId('todos-ro-toast-undo')));
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('打勾、删除：都不写，出同一条提示（× 是 aria-disabled）；可写的行照常写、照常进编辑页', async () => {
    render(<TodosPage />);
    fireEvent.click(screen.getByTestId('todos-done-ro1'));
    expect(await screen.findByTestId('todos-ro-toast')).toBeTruthy();
    // 只读行的 × 和打勾圆圈一样（FA-2 视觉验收第二轮第 1 条）：aria-disabled、读屏名字接“要更新到新版本才能修改”，点了拦下不写
    const x = screen.getByTestId('todos-del-ro1');
    expect(x.getAttribute('aria-disabled')).toBe('true');
    expect(x.getAttribute('aria-label')).toBe('删除，要更新到新版本才能修改');
    fireEvent.click(x);
    expect(screen.getByTestId('todos-del-ok1').getAttribute('aria-disabled')).toBeNull();
    expect(setDone).not.toHaveBeenCalled();
    expect(setDeleted).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('todos-del-ok1'));
    });
    expect(setDeleted).toHaveBeenCalledTimes(1);
    fireEvent.click(titleBtn('回邮件'));
    expect(window.location.hash).toBe('#/todo/ok1');
  });

  it('数据层把这一行变回可写：标记跟着消失', async () => {
    render(<TodosPage />);
    expect((await screen.findByTestId('todos-ro-ro1'))).toBeTruthy();
    await act(async () => {
      readonlyIds('todos').set([{ id: 'ro1', ro: false }]);
    });
    expect(screen.queryByTestId('todos-ro-ro1')).toBeNull();
  });
});
