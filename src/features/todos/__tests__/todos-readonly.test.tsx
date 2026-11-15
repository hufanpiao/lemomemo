// 待办列表的只读行（FA-2 只读行界面；架构 0.27 第 1 点）：行尾“要新版本”标记；点这一行、打勾统一拦下（不进编辑页、不写），左滑删除滑不开，
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

/** 在这一行的行面上左滑 50 px（过操作区一半就停在露出） */
function swipeLeft(id: string): void {
  const el = screen.getByTestId(`todos-swipe-${id}`).querySelector<HTMLElement>('[data-swipe-face]') as HTMLElement;
  fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 20, button: 0, pointerType: 'touch' });
  fireEvent.pointerMove(el, { pointerId: 1, isPrimary: true, clientX: 175, clientY: 20, pointerType: 'touch' });
  fireEvent.pointerMove(el, { pointerId: 1, isPrimary: true, clientX: 150, clientY: 20, pointerType: 'touch' });
  fireEvent.pointerUp(el, { pointerId: 1, isPrimary: true, clientX: 150, clientY: 20, pointerType: 'touch' });
}

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

  it('打勾、删除：都不写（打勾出提示条，只读行左滑不动）；可写的行左滑露出“删除”照常写、照常进编辑页', async () => {
    // jsdom 量不出宽度、没有指针捕获（同 kit 的 SwipeRow.test.tsx）
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-swipe-face') ? 360 : 72;   // 整行 360、“删除”按钮 72
    });
    HTMLElement.prototype.setPointerCapture = () => undefined;
    render(<TodosPage />);
    fireEvent.click(titleBtn('回邮件'));
    expect(window.location.hash).toBe('#/todo/ok1');
    window.location.hash = '#/todos';
    fireEvent.click(screen.getByTestId('todos-done-ro1'));
    expect(await screen.findByTestId('todos-ro-toast')).toBeTruthy();
    // 只读行（负责人 11-15 去掉 × 改左滑）：滑不开、露不出“删除”
    swipeLeft('ro1');
    expect(screen.getByTestId('todos-swipe-ro1').getAttribute('data-swipe')).toBeNull();
    expect(setDone).not.toHaveBeenCalled();
    expect(setDeleted).not.toHaveBeenCalled();
    swipeLeft('ok1');
    expect(screen.getByTestId('todos-swipe-ok1').getAttribute('data-swipe')).toBe('open');
    await act(async () => {
      fireEvent.click(screen.getByTestId('todos-swipe-del-ok1'), { detail: 1 });
    });
    expect(setDeleted).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
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
