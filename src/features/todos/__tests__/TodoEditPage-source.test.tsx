// 待办编辑页的“来源”行（R-415 ①，负责人定方案丙）：随手记转来的待办，最后一组末尾“来源 随手记 · 标题 ›”，点了打开那条随手记。
// • 出：原随手记在本机、活着 → 能点的一行（标题经 noteHeadline，没标题取正文第一行），读屏名称带“来源”
// • 不出（负责人 11-13：原条不在就整行不出，不变灰、不写原因）：from_note_id 为空、本机没有、隐私记、撤销了、删了（在“最近删除”里）
// • 原条变了跟着变：活着 → 删除 → 恢复、活着 → 变隐私记、活着 → 撤销；状态一变运行日志记 todo source <码>
// 用真实的冷启动（假 IndexedDB），服务器行经 applyServer 进集合
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import type { ServerRow } from '../../../core/cache.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { sourceOf } from '../data/todo-edit.ts';
import TodoEditPage from '../ui/TodoEditPage.tsx';

const ID = '00000000-0000-4000-8000-0000000000b1';
const NOTE = '00000000-0000-4000-8000-0000000000c1';
/** 随手记原来的标题（和待办标题不同，好查它有没有露在页面上） */
const NOTE_TITLE = '周末去首尔林';

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
    id: NOTE, title: NOTE_TITLE, body: '下周末带相机', is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
    tags: [], converted_to: [{ kind: 'todo', id: ID }], source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1, rev: 1, ...over,
  }) as ServerRow;

/** 隐私记的真实形状（B5）：明文标题、正文为空，内容在 body_enc 里 */
const PRIVATE = { is_private: true, title: null, body: null, body_enc: 'enc:v1:xxxx', enc_key_id: 1 };

let lines: string[] = [];
const sourceLines = () => lines.filter((l) => l.startsWith('todo source'));

async function setup(todo: Record<string, unknown>, note: Record<string, unknown> | null) {
  lines = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
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

/** 服务器那边这条随手记变了（rev 递增） */
let rev = 1;
async function noteBecomes(b: Awaited<ReturnType<typeof boot>>, over: Record<string, unknown>) {
  await act(async () => {
    await b.outbox?.applyServer('notes', [{ row: serverNote({ ...over, rev: ++rev }) }]);
  });
}

function teardown() {
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
  cleanup();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
}

beforeEach(() => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
});
afterEach(teardown);

describe('sourceOf（来源行的状态）', () => {
  const n = (over: Record<string, unknown> = {}) => ({ id: NOTE, title: '标题', body: '', deleted_at: null, undone: false, is_private: false, ...over });
  it('活着的随手记 → ok，能点；没有标题取正文第一个非空行（同随手记列表）', () => {
    expect(sourceOf(n())).toEqual({ state: 'ok', id: NOTE, title: '标题' });
    expect(sourceOf(n({ title: null, body: '\n  第一行 \n第二行' }))).toEqual({ state: 'ok', id: NOTE, title: '第一行' });
  });
  it('本机没有 → none；隐私记（真实形状 title 为 null）→ private；撤销了 → undone；删了 → gone：都只有状态码、不带标题', () => {
    expect(sourceOf(undefined)).toEqual({ state: 'none' });
    expect(sourceOf(n(PRIVATE))).toEqual({ state: 'private' });
    expect(sourceOf(n({ ...PRIVATE, deleted_at: 5 }))).toEqual({ state: 'private' });
    expect(sourceOf(n({ deleted_at: 5, undone: true }))).toEqual({ state: 'undone' });
    expect(sourceOf(n({ deleted_at: 5 }))).toEqual({ state: 'gone' });
  });
});

describe('待办编辑页的“来源”行', () => {
  it('出：最后一组末尾一行“来源 随手记 · 标题 ›”，链到 #/note/<id>，读屏名称带“来源”，点了打开那条随手记', async () => {
    await setup({}, {});
    const link = screen.getByTestId('todo-edit-source');
    expect(link.textContent).toBe(`随手记 · ${NOTE_TITLE}›`);
    expect(link.getAttribute('href')).toBe(`#/note/${NOTE}`);
    expect(link.getAttribute('aria-label')).toBe(`来源 随手记 · ${NOTE_TITLE}`);
    // 和项目、备注同一组，排在最后
    const group = link.closest('[class*="group"]');
    expect(group?.textContent).toContain('项目');
    expect(group?.lastElementChild?.contains(link)).toBe(true);
    expect(group?.lastElementChild?.textContent?.startsWith('来源')).toBe(true);
    expect(sourceLines()).toEqual(['todo source ok']);
    fireEvent.click(link, { button: 0 });
    await waitFor(() => expect(window.location.hash).toBe(`#/note/${NOTE}`));
  });

  it('不出：from_note_id 为空（不记日志）、本机没有那条随手记、隐私记（真实形状）、撤销了的、删了的', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown> | null, string[]][] = [
      [{ from_note_id: null }, {}, []],
      [{}, null, ['todo source none']],
      [{}, PRIVATE, ['todo source private']],
      [{}, { undone: true, deleted_at: 3 }, ['todo source undone']],
      [{}, { deleted_at: 9 }, ['todo source gone']],
    ];
    for (const [todo, note, log] of cases) {
      await setup(todo, note);
      expect(screen.queryByTestId('todo-edit-source')).toBeNull();
      expect(screen.queryByText('来源')).toBeNull();
      expect(document.body.textContent).not.toContain(NOTE_TITLE);
      expect(sourceLines()).toEqual(log);
      teardown();
      clearAllCollections();
    }
  });

  it('活着 → 删除（进“最近删除”）→ 恢复：整行不出，恢复后自动重新出现', async () => {
    const b = await setup({}, {});
    expect(screen.getByTestId('todo-edit-source')).toBeTruthy();
    await noteBecomes(b, { deleted_at: 9 });
    await waitFor(() => expect(screen.queryByTestId('todo-edit-source')).toBeNull());
    expect(screen.queryByText('来源')).toBeNull();
    await noteBecomes(b, { deleted_at: null });
    await waitFor(() => expect(screen.getByTestId('todo-edit-source').getAttribute('href')).toBe(`#/note/${NOTE}`));
    expect(sourceLines()).toEqual(['todo source ok', 'todo source gone', 'todo source ok']);
  });

  it('活着 → 变成隐私记：整行不出，页面上不留原标题', async () => {
    const b = await setup({}, {});
    expect(document.body.textContent).toContain(NOTE_TITLE);
    await noteBecomes(b, PRIVATE);
    await waitFor(() => expect(screen.queryByTestId('todo-edit-source')).toBeNull());
    expect(document.body.textContent).not.toContain(NOTE_TITLE);
    expect(sourceLines()).toEqual(['todo source ok', 'todo source private']);
  });

  it('活着 → 撤销（undone）：整行不出', async () => {
    const b = await setup({}, {});
    await noteBecomes(b, { undone: true, deleted_at: 3 });
    await waitFor(() => expect(screen.queryByTestId('todo-edit-source')).toBeNull());
    expect(document.body.textContent).not.toContain(NOTE_TITLE);
    expect(sourceLines()).toEqual(['todo source ok', 'todo source undone']);
  });

  it('标题过长：单行省略（kit FieldLink 的 .linkText 在 CSS 里 nowrap + ellipsis，截图核过；这里只查结构：文字包在一个 span 里，箭头单独一个、读屏不读）', async () => {
    await setup({}, { title: '很长'.repeat(60) });
    const link = screen.getByTestId('todo-edit-source');
    expect(link.children).toHaveLength(2);
    expect(link.children[1]?.getAttribute('aria-hidden')).toBe('true');
  });
});
