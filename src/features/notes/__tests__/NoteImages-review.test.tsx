// 随手记插图：代码审、视觉验收、安全审之后补的（B4 S3 第二轮）——提示只认本条、行段失败改为重新选一张、输入行不留空条、列表缩略图、封面标出错、取不到过 30 秒再取、隐私记不让插
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ServerRow } from '../../../core/cache.ts';
import { collection } from '../../../core/store.ts';
import { setMissingRecheckMsForTest } from '../hooks/useNoteImages.ts';
import { boot, jpg, open, pick, sendNext, serverImage, serverNote, setupImageTests, uid, wire, type Row } from './note-images-kit.tsx';

setupImageTests();

describe('代码审必改（提示只认本条、行段失败改为重新选一张）', () => {
  it('编辑器只出这一条随手记的插图提示：别的随手记的图被拒不显示在这里', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }, { row: serverNote(2) }]);
    });
    wire({ upload: () => Promise.resolve({ ok: false, kind: 'denied', code: 'forbidden', reason: 'quota_exceeded', status: 403 }) });
    open(`#/note/${uid(1)}`);
    await screen.findByTestId('note-images');
    const { uploader } = await import('../data/image-uploader.ts');
    await act(async () => {
      await uploader().insert(uid(2), jpg());
    });
    await act(async () => {
      await sendNext();
    });
    await waitFor(() => expect(uploader().getSnapshot()).toMatchObject([{ noteId: uid(2), state: 'failed' }]));
    expect(screen.queryByTestId('note-edit-img-msg')).toBeNull();
    await act(async () => {
      pick('note-edit-img-input', jpg());
    });
    await act(async () => {
      await sendNext();
    });
    expect((await screen.findByTestId('note-edit-img-msg')).textContent).toContain('空间满了');
  });

  it('写行被拒（quota_exceeded）后点“重新插入”：不重传、不重发提示，改开选图框；选了新图插进去，旧的这张（发送失败区）放弃', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    const { upload } = wire();
    open(`#/note/${uid(1)}`);
    await act(async () => {
      pick('note-edit-img-input', jpg());
    });
    await act(async () => {
      await sendNext('quota_exceeded');
    });
    const old = collection<Row>('note_images').getSnapshot()[0]?.id ?? '';
    await waitFor(() => expect(screen.getByTestId(`note-image-${old}`).getAttribute('data-state')).toBe('failed'));
    const { uploader } = await import('../data/image-uploader.ts');
    const notices: unknown[] = [];
    const off = uploader().onNotice((n) => notices.push(n));
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await act(async () => fireEvent.click(screen.getByTestId(`note-image-reinsert-${old}`)));
    expect(click).toHaveBeenCalledTimes(1);
    await new Promise((res) => setTimeout(res, 30));
    expect(notices).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    await act(async () => pick(`note-image-reinsert-input-${old}`, jpg()));
    await waitFor(() => expect(collection<Row>('note_images').get(old)).toBeUndefined());
    expect(collection<Row>('note_images').getSnapshot().map((r) => r.id)).toHaveLength(1);
    off();
  });
});

describe('视觉验收必改（列表缩略图、封面标出错）和“还没传上”过一会儿再取', () => {
  it('列表视图：有图的行在“⋯”前放缩略图（用缩略图那一份）；没图的行没有', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }, { row: serverNote(2) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(71), uid(1)) }]);
      await b.outbox?.applyServer('settings', [{ row: { id: uid(900), key: 'notes.view@desktop', value: 'list', deleted_at: null, undone: false, rev: 1 } as ServerRow }]);
    });
    wire();
    open();
    const th = await screen.findByTestId(`notes-thumb-${uid(1)}`);
    await waitFor(() => expect(th.querySelector('img')?.getAttribute('src')).toBe('blob:remote'));
    expect(screen.getByTestId(`notes-row-${uid(1)}`).contains(th)).toBe(true);
    expect(screen.queryByTestId(`notes-thumb-${uid(2)}`)).toBeNull();
  });

  it('取不到：卡片封面标“图片还没传上”、列表缩略图标“!”（读屏念原因）；过一会儿再取一次，取到了就出图', async () => {
    setMissingRecheckMsForTest(30);
    let missing = true;
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(71), uid(1)) }]);
    });
    wire({ missing: () => missing });
    open();
    const cover = screen.getByTestId(`notes-cover-${uid(1)}`);
    await waitFor(() => expect(cover.getAttribute('data-state')).toBe('failed'));
    expect(cover.textContent).toContain('图片还没传上');
    expect(cover.querySelector('img')).toBeNull();
    missing = false;
    await waitFor(() => expect(cover.getAttribute('data-state')).toBe('ok'));
    expect(cover.querySelector('img')?.getAttribute('src')).toBe('blob:remote');
    setMissingRecheckMsForTest(null);
  });

  it('隐私记里不让插图：提示“隐私记里不能插图片”，不写行（安全审建议 5）', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: { ...serverNote(1), is_private: true } as ServerRow }]);
    });
    wire();
    open(`#/note/${uid(1)}`);
    await act(async () => pick('note-edit-img-input', jpg()));
    expect((await screen.findByTestId('note-edit-img-msg')).textContent).toContain('隐私记里不能插图片');
    expect(collection<Row>('note_images').getSnapshot()).toEqual([]);
  });
});
