// 随手记界面的数据来源（hooks/note-source.ts，B5 隐私记重写 11-15）
// • H4：来源不让转（caps.convert = false，隐私记）时，useNoteList.convert 直接拒，不调 convertNote（它写本机 todos / events / outbox）
// • L6：来源不支持合并分类（caps.merge = false）时，useNoteList 不调 fixCategoryCycles（它写本机 categories）
// • 默认来源（普通随手记）和收拢之前一模一样：写入原样转给 core 的 saveInsert / saveDeleted / savePatch（参数、返回值不改），
//   行读本机集合 notes、note_images、note_files，只读 id 读 readonlyIds('notes')，撤销新建写 undone
// • “最近删除”入口（NotesBits 的 TrashLink，负责人 11-15）：两种来源共用一份，去哪、带不带条数看来源
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Row } from '../data/note-list.ts';

const convertNote = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, table: 'todos' as const, id: 'x' })));
vi.mock('../data/note-convert.ts', () => ({ convertNote }));
const fixCategoryCycles = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../data/category-merge-store.ts', async (orig) => ({ ...(await orig<object>()), fixCategoryCycles }));
const save = vi.hoisted(() => ({
  saveInsert: vi.fn(async () => 'saved' as const),
  savePatch: vi.fn(async () => 'saved' as const),
  saveDeleted: vi.fn(async () => 'saved' as const),
}));
vi.mock('../../../core/edit-save.ts', async (orig) => ({ ...(await orig<object>()), ...save }));
const read = vi.hoisted(() => ({ collections: [] as string[], ro: [] as string[], items: [] as [string, string | null][] }));
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) => {
    read.collections.push(name);
    return [];
  },
}));
vi.mock('../../../kit/hooks/useReadonly.ts', async (orig) => ({
  ...(await orig<object>()),
  useReadonlyIds: (table: string) => {
    read.ro.push(table);
    return new Set<string>();
  },
}));
vi.mock('../../../kit/hooks/useItem.ts', () => ({
  useItem: (table: string, id: string | null) => {
    read.items.push([table, id]);
    return undefined;
  },
}));

const { NoteSourceProvider } = await import('../hooks/note-source.ts');
const { notesSource } = await import('../hooks/note-source-default.ts');
const { useNoteList } = await import('../hooks/useNoteList.ts');
const { TrashLink } = await import('../ui/NotesBits.tsx');

const NID = '11111111-1111-4111-8111-111111111111';
const ROW: Row = {
  id: NID, title: '体检', body: '血压', category_id: null, category_source: 'manual', category_seen: true, is_private: false,
  converted_to: null, undone: false, created_at: 1, updated_at: 1, deleted_at: null,
};
const rows = { notes: [ROW], images: [], files: [] };

function wrap(convert: boolean, merge = true) {
  const src = { ...notesSource, caps: { ...notesSource.caps, convert, merge }, useRows: () => rows };
  return function Wrap({ children }: { children: ReactNode }) {
    return <NoteSourceProvider value={src}>{children}</NoteSourceProvider>;
  };
}

describe('H4：来源不让转时 convert 兜底拒掉', () => {
  it('caps.convert = false：回 rejected，convertNote 一次都没调（本机 todos、events、outbox 不写）', async () => {
    convertNote.mockClear();
    const { result } = renderHook(() => useNoteList(), { wrapper: wrap(false) });
    let r: Awaited<ReturnType<typeof result.current.convert>> | undefined;
    await act(async () => {
      r = await result.current.convert(NID, 'todo', false);
    });
    expect(r).toMatchObject({ ok: false, reason: 'rejected' });
    expect(convertNote).not.toHaveBeenCalled();
  });

  it('对照：caps.convert = true（普通随手记）照常交给 convertNote', async () => {
    convertNote.mockClear();
    const { result } = renderHook(() => useNoteList(), { wrapper: wrap(true) });
    await act(async () => {
      await result.current.convert(NID, 'todo', false);
    });
    expect(convertNote).toHaveBeenCalledTimes(1);
  });
});

describe('L6：来源不支持合并分类时不写回分类圈', () => {
  it('caps.merge = false：fixCategoryCycles 一次都没调', () => {
    fixCategoryCycles.mockClear();
    renderHook(() => useNoteList(), { wrapper: wrap(true, false) });
    expect(fixCategoryCycles).not.toHaveBeenCalled();
  });

  it('对照：caps.merge = true 照常调', () => {
    fixCategoryCycles.mockClear();
    renderHook(() => useNoteList(), { wrapper: wrap(true, true) });
    expect(fixCategoryCycles).toHaveBeenCalled();
  });
});

describe('批 2 第 8 条：默认来源（普通随手记）和收拢之前一模一样', () => {
  it('editIo 的 insert / setDeleted / patch 原样转给 core 的 saveInsert / saveDeleted / savePatch，返回值不改', async () => {
    const row = { id: NID, title: '', body: '买牛奶' };
    expect(await notesSource.editIo.insert('notes', row, true)).toBe('saved');
    expect(save.saveInsert).toHaveBeenLastCalledWith('notes', row, true);
    expect(await notesSource.editIo.setDeleted('notes', NID, true, 123, false)).toBe('saved');
    expect(save.saveDeleted).toHaveBeenLastCalledWith('notes', NID, true, 123, false);
    expect(await notesSource.editIo.patch('notes', NID, { body: '改了' }, false)).toBe('saved');
    expect(save.savePatch).toHaveBeenLastCalledWith('notes', NID, { body: '改了' }, false);
  });

  it('撤销刚新建的一条：savePatch 写 undone，不带提醒', async () => {
    save.savePatch.mockClear();
    await notesSource.discard(NID);
    expect(save.savePatch).toHaveBeenCalledWith('notes', NID, { undone: true, updated_at: expect.any(Number) }, false);
  });

  it('useRows 读本机集合 notes、note_images、note_files；只读 id 读 readonlyIds(notes)；编辑页的行读 useItem', () => {
    read.collections.length = 0;
    read.ro.length = 0;
    read.items.length = 0;
    renderHook(() => ({ rows: notesSource.useRows(), ro: notesSource.useReadonly(), row: notesSource.editIo.useRow('notes', NID) }));
    expect([...new Set(read.collections)]).toEqual(['notes', 'note_images', 'note_files']);
    expect([...new Set(read.ro)]).toEqual(['notes']);
    expect(read.items[0]).toEqual(['notes', NID]);
  });
});

describe('“最近删除”入口（负责人 11-15）', () => {
  const at = (src: typeof notesSource) => render(<NoteSourceProvider value={src}><TrashLink /></NoteSourceProvider>);

  it('随手记：“最近删除”不带条数，点了进全站的 #/trash', async () => {
    window.history.replaceState(null, '', '/app/#/notes');
    at(notesSource);
    const b = screen.getByTestId('notes-open-trash');
    expect(b.textContent).toBe('最近删除');
    await act(async () => {
      fireEvent.click(b);
    });
    expect(window.location.hash).toBe('#/trash');
    cleanup();
  });

  it('隐私记来源：用来源的字、带条数，点了进 #/vault/trash', async () => {
    window.history.replaceState(null, '', '/app/#/vault');
    at({ ...notesSource, kind: 'vault', trash: ['vault', 'trash'], useTrashCount: () => 2, text: { title: '隐私记', empty: '', back: '', trash: '最近删除' } });
    const b = screen.getByTestId('vault-open-trash');
    expect(b.textContent).toBe('最近删除 2');
    await act(async () => {
      fireEvent.click(b);
    });
    expect(window.location.hash).toBe('#/vault/trash');
    cleanup();
  });
});
