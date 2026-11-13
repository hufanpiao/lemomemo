// 待办编辑页的“来源”行（R-415 ①，负责人定方案丙）：随手记转来的待办，最后一组末尾“来源 随手记 · 标题 ›”，点了打开那条随手记。
// • 有：原随手记在本机、活着 → 能点的一行（标题经 noteHeadline，没标题取正文第一行）；随手记删了、恢复了跟着变
// • 没有：from_note_id 为空、本机没有这一条、撤销了的、隐私记 → 不出这一行
// • 原条不在（删了，在“最近删除”里）→ 变灰、不能点，下面一行灰字“原随手记在‘最近删除’里”
// 用真实的冷启动（假 IndexedDB），服务器行经 applyServer 进集合
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { sourceOf } from '../data/todo-edit.ts';
import TodoEditPage from '../ui/TodoEditPage.tsx';

const ID = '00000000-0000-4000-8000-0000000000b1';
const NOTE = '00000000-0000-4000-8000-0000000000c1';

async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}

const serverTodo = (over: Record<string, unknown> = {}): ServerRow =>
  ({
    id: ID, title: '首尔林银杏黄了', done: false, due: null, important: false, project: '', note: '下周末带相机', source: 'page', raw_text: '',
    batch_id: null, from_note_id: NOTE, from_anniv_id: null, short: null, short_by: null, done_at: 0, remind_days: null, remind_time: '09:00',
    due_time: null, remind_before_min: null, push_show_title: null, notified_for: null, snooze_at: null, deleted_at: null, undone: false,
    created_at: 1, updated_at: 1, rev: 1, ...over,
  }) as ServerRow;

const serverNote = (over: Record<string, unknown> = {}): ServerRow =>
  ({
    id: NOTE, title: '首尔林银杏黄了', body: '下周末带相机', is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
    tags: [], converted_to: [{ kind: 'todo', id: ID }], source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1, rev: 1, ...over,
  }) as ServerRow;

async function setup(todo: Record<string, unknown>, note: Record<string, unknown> | null) {
  const b = await boot();
  await act(async () => {
    await b.outbox?.applyServer('todos', [{ row: serverTodo(todo) }]);
    if (note) await b.outbox?.applyServer('notes', [{ row: serverNote(note) }]);
  });
  window.history.replaceState(null, '', `/app/#/todo/${ID}`);
  render(<TodoEditPage />);
  await screen.findByTestId('todo-edit-title');
  return b;
}

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('sourceOf（来源行出不出、出成什么样）', () => {
  const n = (over: Record<string, unknown> = {}) => ({ id: NOTE, title: '标题', body: '', deleted_at: null, undone: false, is_private: false, ...over });
  it('活着的随手记 → 能点；没有标题取正文第一个非空行（同随手记列表）', () => {
    expect(sourceOf(n())).toEqual({ id: NOTE, title: '标题', gone: false });
    expect(sourceOf(n({ title: null, body: '\n  第一行 \n第二行' }))).toEqual({ id: NOTE, title: '第一行', gone: false });
  });
  it('删了的 → gone；本机没有、撤销了的、隐私记 → null', () => {
    expect(sourceOf(n({ deleted_at: 5 }))?.gone).toBe(true);
    expect(sourceOf(undefined)).toBeNull();
    expect(sourceOf(n({ deleted_at: 5, undone: true }))).toBeNull();
    expect(sourceOf(n({ is_private: true }))).toBeNull();
  });
});

describe('待办编辑页的“来源”行', () => {
  it('有：最后一组末尾一行“来源 随手记 · 标题 ›”，链到 #/note/<id>，点了打开那条随手记', async () => {
    await setup({}, {});
    const link = screen.getByTestId('todo-edit-source');
    expect(link.textContent).toBe('随手记 · 首尔林银杏黄了›');
    expect(link.getAttribute('href')).toBe(`#/note/${NOTE}`);
    // 和项目、备注同一组，排在最后
    const group = link.closest('[class*="group"]');
    expect(group?.textContent).toContain('项目');
    expect(group?.lastElementChild?.contains(link)).toBe(true);
    expect(group?.lastElementChild?.textContent?.startsWith('来源')).toBe(true);
    fireEvent.click(link, { button: 0 });
    await waitFor(() => expect(window.location.hash).toBe(`#/note/${NOTE}`));
  });

  it('没有：from_note_id 为空、本机没有那条随手记、隐私记，都不出这一行', async () => {
    await setup({ from_note_id: null }, {});
    expect(screen.queryByTestId('todo-edit-source')).toBeNull();
    expect(screen.queryByText('来源')).toBeNull();
    cleanup();
    getBoot()?.cache?.close();
    resetBootForTest();
    clearAllCollections();

    await setup({}, null);
    expect(screen.queryByText('来源')).toBeNull();
    cleanup();
    getBoot()?.cache?.close();
    resetBootForTest();
    clearAllCollections();

    await setup({}, { is_private: true });
    expect(screen.queryByText('来源')).toBeNull();
  });

  it('原条不在（删了，在“最近删除”里）：变灰、不能点，下面一行说明；恢复以后变回能点', async () => {
    const b = await setup({}, { deleted_at: 9 });
    const gone = screen.getByTestId('todo-edit-source-gone');
    expect(gone.textContent).toBe('随手记 · 首尔林银杏黄了');
    expect(gone.closest('a')).toBeNull();
    expect(screen.queryByTestId('todo-edit-source')).toBeNull();
    expect(screen.getByText('原随手记在“最近删除”里')).toBeTruthy();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote({ deleted_at: null, rev: 2 }) }]);
    });
    await waitFor(() => expect(screen.getByTestId('todo-edit-source').getAttribute('href')).toBe(`#/note/${NOTE}`));
    expect(screen.queryByText('原随手记在“最近删除”里')).toBeNull();
  });

  it('标题过长：单行省略（kit FieldLink 的 .linkText 在 CSS 里 nowrap + ellipsis，截图核过；这里只查结构：文字包在一个 span 里，箭头单独一个、读屏不读）', async () => {
    await setup({}, { title: '很长'.repeat(60) });
    const link = screen.getByTestId('todo-edit-source');
    expect(link.children).toHaveLength(2);
    expect(link.children[1]?.getAttribute('aria-hidden')).toBe('true');
  });
});
