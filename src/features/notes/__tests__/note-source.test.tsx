// 随手记界面的数据来源（hooks/note-source.ts，B5 隐私记重写 11-15）
// • H4：来源不让转（caps.convert = false，隐私记）时，useNoteList.convert 直接拒，不调 convertNote（它写本机 todos / events / outbox）
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Row } from '../data/note-list.ts';

const convertNote = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, table: 'todos' as const, id: 'x' })));
vi.mock('../data/note-convert.ts', () => ({ convertNote }));

const { NoteSourceProvider } = await import('../hooks/note-source.ts');
const { notesSource } = await import('../hooks/note-source-default.ts');
const { useNoteList } = await import('../hooks/useNoteList.ts');

const NID = '11111111-1111-4111-8111-111111111111';
const ROW: Row = {
  id: NID, title: '体检', body: '血压', category_id: null, category_source: 'manual', category_seen: true, is_private: false,
  converted_to: null, undone: false, created_at: 1, updated_at: 1, deleted_at: null,
};
const rows = { notes: [ROW], images: [], files: [] };

function wrap(convert: boolean) {
  const src = { ...notesSource, caps: { ...notesSource.caps, convert }, useRows: () => rows };
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
