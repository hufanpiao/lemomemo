// 随手记插图的页面（B4 S3；TC-B4-11 前端一半；主持人定的 4 件事）：
// 输入行“图片”“拍照”并排（拍照带 capture="environment"）；输入行选了图先挂成待记下的小图、点“记下”才新建（R-416），之后先写行（deps 指向随手记）、确认后才传原图和 .t.webp；
// 卡片顶部 16:10 的图和“+N”；HEIC 打不开提示“请先转成 JPG”、不留空随手记；上传超限提示带“最近删除”入口；写行被拒（quota_exceeded）同样提示；
// 编辑器里没传上的图（页面关过）出“图片没传上”和“删除”“重新插入”，删除是软删
// 用真实的冷启动（假 IndexedDB）：写入经 write.* 进 outbox；只换掉编码、上传、签名取字节（jsdom 没有 canvas、没有网络）
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getBoot } from '../../../core/boot.ts';
import type { EncodeResult } from '../data/image-encode.ts';
import { collection } from '../../../core/store.ts';
import { boot, jpg, NOW, okEnc, open, pick, remember, sendNext, serverImage, serverNote, setupImageTests, uid, USER, wire, type Row } from './note-images-kit.tsx';

setupImageTests();

describe('选图按钮（主持人定 3；视觉验收必改 4）', () => {
  it('输入行只有“图片”（收 image/*，不带 capture）；编辑器里“图片”“拍照”并排，拍照的带 capture="environment"', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    wire();
    const v = open();
    expect(screen.getByTestId('notes-img').getAttribute('aria-label')).toBe('图片');
    expect(screen.queryByTestId('notes-camera')).toBeNull();
    expect(screen.queryByTestId('notes-camera-input')).toBeNull();
    expect(screen.getByTestId('notes-img-input').getAttribute('accept')).toBe('image/*');
    expect(screen.getByTestId('notes-img-input').hasAttribute('capture')).toBe(false);
    v.unmount();
    open(`#/note/${uid(1)}`);
    expect(screen.getByTestId('note-edit-img').getAttribute('aria-label')).toBe('图片');
    expect(screen.getByTestId('note-edit-camera').getAttribute('aria-label')).toBe('拍照');
    expect(screen.getByTestId('note-edit-camera-input').getAttribute('accept')).toBe('image/*');
    expect(screen.getByTestId('note-edit-camera-input').getAttribute('capture')).toBe('environment');
  });

  it('选了图先挂成待记下的小图、不新建（R-416）；点“记下”：新建一条随手记（正文是输入框里的字）、写 note_images 行（deps 指向随手记）；确认前不传，确认后依次传原图和 .t.webp；卡片顶部出图', async () => {
    await boot();
    const { upload } = wire();
    open();
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: '银杏' } });
    await act(async () => {
      pick('notes-img-input', jpg());
    });
    expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(collection<Row>('notes').getSnapshot()).toEqual([]);
    expect(collection<Row>('note_images').getSnapshot()).toEqual([]);
    expect((screen.getByTestId('notes-input') as HTMLInputElement).value).toBe('银杏');
    await act(async () => remember());
    const note = await waitFor(() => {
      const n = collection<Row>('notes').getSnapshot().find((r) => r['body'] === '银杏');
      if (!n) throw new Error('no_note');
      return n;
    });
    const img = await waitFor(() => {
      const i = collection<Row>('note_images').getSnapshot()[0];
      if (!i) throw new Error('no_image');
      return i;
    });
    expect(img).toMatchObject({ note_id: note.id, bucket: 'images', path: `${USER}/${note.id}/${img.id}.webp`, bytes: 7, has_thumb: true });
    const items = (await getBoot()?.outbox?.list()) ?? [];
    expect(items.find((x) => x.table === 'note_images')?.deps).toEqual([{ table: 'notes', id: note.id }]);
    expect((screen.getByTestId('notes-input') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('notes-pend')).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(upload).not.toHaveBeenCalled();
    await act(async () => {
      await sendNext(); // 随手记
      await sendNext(); // 插图那一行
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map((c) => c[0])).toEqual([`${USER}/${note.id}/${img.id}.webp`, `${USER}/${note.id}/${img.id}.t.webp`]);
    const cover = screen.getByTestId(`notes-cover-${note.id}`);
    expect(cover.querySelector('img')?.getAttribute('src')).toBe('blob:local');
    expect(cover.textContent).toBe('');
  });

  it('HEIC 打不开：点“记下”后提示“请先转成 JPG”（R-377）；不新建随手记、不写行，输入框里的字和那张图放回去', async () => {
    await boot();
    wire({ encode: () => Promise.resolve({ ok: false, code: 'heic_unsupported' }) });
    open();
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: '这张' } });
    await act(async () => {
      pick('notes-img-input', new File([new Uint8Array(3)], 'IMG_1.HEIC', { type: 'image/heic' }));
    });
    await act(async () => remember());
    await waitFor(() => expect(screen.getByTestId('notes-img-tip').textContent).toBe('这张是 HEIC 格式，浏览器打不开，请先转成 JPG'));
    expect(collection<Row>('notes').getSnapshot()).toEqual([]);
    expect(collection<Row>('note_images').getSnapshot()).toEqual([]);
    expect((screen.getByTestId('notes-input') as HTMLInputElement).value).toBe('这张');
    await waitFor(() => expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(1));
  });

  it('输入框没字、图片行写不进去：刚新建的空随手记撤销（undone），列表里不留空条；提示“没存上”', async () => {
    await boot();
    wire({ insertFails: true });
    open();
    await act(async () => {
      pick('notes-img-input', jpg());
    });
    await act(async () => remember());
    // 新建后又撤销：队列里新建和撤销合并掉，什么都不上服务器，本机集合里也没有这一条
    await waitFor(async () => {
      expect(collection<Row>('notes').getSnapshot()).toEqual([]);
      expect(((await getBoot()?.outbox?.list()) ?? []).filter((x) => x.table === 'notes')).toEqual([]);
    });
    await waitFor(() => expect(screen.queryAllByTestId(/^notes-card-/)).toEqual([]));
    expect(await screen.findByTestId('notes-img-tip')).toBeTruthy();
    // 没插成的图放回输入行（R-416），不丢
    expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(1);
  });

  it('输入框有字、图片行写不进去：随手记留着（字不丢）', async () => {
    await boot();
    wire({ insertFails: true });
    open();
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: '留着' } });
    await act(async () => pick('notes-img-input', jpg()));
    await act(async () => remember());
    await waitFor(() => expect(screen.getByTestId('notes-img-tip')).toBeTruthy());
    expect(collection<Row>('notes').getSnapshot()).toMatchObject([{ body: '留着' }]);
    expect(screen.getAllByTestId(/^notes-card-/)).toHaveLength(1);
    // 字记成了一条、输入框清空；没插成的图放回输入行（R-416）
    expect((screen.getByTestId('notes-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(1);
  });
});

describe('输入行待记下的图（R-416，负责人 11-13“选择要上传的图片后不应该直接记录”）', () => {
  it('选三张、“×”去掉第二张：点“记下”只新建一条，剩下两张都插进这一条（同一个 note_id），输入行的小图清空', async () => {
    await boot();
    wire();
    open();
    await act(async () => {
      pick('notes-img-input', jpg());
      pick('notes-img-input', jpg());
      pick('notes-img-input', jpg());
    });
    expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('notes-pend-del-1').getAttribute('aria-label')).toBe('去掉第 2 张图片');
    fireEvent.click(screen.getByTestId('notes-pend-del-1'));
    expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(2);
    expect(collection<Row>('notes').getSnapshot()).toEqual([]);
    await act(async () => remember());
    const imgs = await waitFor(() => {
      const r = collection<Row>('note_images').getSnapshot();
      if (r.length < 2) throw new Error('not_yet');
      return r;
    });
    const notes = collection<Row>('notes').getSnapshot();
    expect(notes).toHaveLength(1);
    expect(imgs.map((i) => i['note_id'])).toEqual([notes[0]?.id, notes[0]?.id]);
    expect(screen.queryByTestId('notes-pend')).toBeNull();
  });

  it('部分插成：两张里一张是 HEIC——记成一条带 1 张图，HEIC 那张放回输入行，字清空、提示“请先转成 JPG”', async () => {
    await boot();
    let n = 0;
    wire({ encode: () => (n++ === 0 ? okEnc() : Promise.resolve({ ok: false, code: 'heic_unsupported' })) });
    open();
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: '两张' } });
    await act(async () => {
      pick('notes-img-input', jpg());
      pick('notes-img-input', new File([new Uint8Array(3)], 'IMG_2.HEIC', { type: 'image/heic' }));
    });
    await act(async () => remember());
    await waitFor(() => expect(screen.getByTestId('notes-img-tip').textContent).toBe('这张是 HEIC 格式，浏览器打不开，请先转成 JPG'));
    const notes = collection<Row>('notes').getSnapshot();
    expect(notes).toMatchObject([{ body: '两张' }]);
    expect(collection<Row>('note_images').getSnapshot().map((i) => i['note_id'])).toEqual([notes[0]?.id]);
    expect((screen.getByTestId('notes-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(1);
  });

  it('“记下”进行中又选了一张、又打了字，这一批没记成：放回的图排在前面、新选的留在后面，新打的字留着（不冲掉）', async () => {
    await boot();
    let done: (r: EncodeResult) => void = () => undefined;
    let first = true;
    wire({
      encode: () => {
        if (!first) return okEnc();
        first = false;
        return new Promise<EncodeResult>((res) => {
          done = res;
        });
      },
    });
    open();
    await act(async () => pick('notes-img-input', jpg()));
    await act(async () => remember());
    expect(screen.queryByTestId('notes-pend')).toBeNull();
    fireEvent.change(screen.getByTestId('notes-input'), { target: { value: '新打的' } });
    await act(async () => pick('notes-img-input', new File([new Uint8Array(5)], 'b.jpg', { type: 'image/jpeg' })));
    await act(async () => done({ ok: false, code: 'heic_unsupported' }));
    await waitFor(() => expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(2));
    expect(screen.getByTestId('notes-pend-del-1').getAttribute('aria-label')).toBe('去掉第 2 张图片');
    expect((screen.getByTestId('notes-input') as HTMLInputElement).value).toBe('新打的');
    expect(collection<Row>('notes').getSnapshot()).toEqual([]);
  });

  it('键盘弹着时点“×”：外框拦掉 mousedown 默认（台账 Q-25，输入框不失焦、第一下就点得中）；去掉后焦点挪到下一张的“×”', async () => {
    await boot();
    wire();
    open();
    await act(async () => {
      pick('notes-img-input', jpg());
      pick('notes-img-input', jpg());
    });
    expect(fireEvent.mouseDown(screen.getByTestId('notes-pend-del-0')), '默认被拦掉').toBe(false);
    act(() => screen.getByTestId('notes-pend-del-0').focus());
    fireEvent.click(screen.getByTestId('notes-pend-del-0'));
    expect(screen.getByTestId('notes-pend').querySelectorAll('li')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByTestId('notes-pend-del-0'));
  });

  it('没字也没图时不出“记下”；只挂了图（没字）就出“记下”', async () => {
    await boot();
    wire();
    open();
    expect(screen.queryByTestId('notes-add')).toBeNull();
    await act(async () => pick('notes-img-input', jpg()));
    expect(screen.getByTestId('notes-add')).toBeTruthy();
  });

  it('浏览器打不开的小图（电脑上的 HEIC 等）不画破图标，只留灰底方块和“×”', async () => {
    await boot();
    wire();
    open();
    await act(async () => pick('notes-img-input', jpg()));
    const pend = screen.getByTestId('notes-pend');
    const img = pend.querySelector('img');
    expect(img).not.toBeNull();
    if (img) fireEvent.error(img);
    expect(pend.querySelector('img')).toBeNull();
    expect(screen.getByTestId('notes-pend-del-0')).toBeTruthy();
  });
});

describe('超限和拒绝（TC-B4-11 前端一半；主持人定 2）', () => {
  it('上传被拒 quota_exceeded：提示带“最近删除”入口（#/trash）', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    wire({ upload: () => Promise.resolve({ ok: false, kind: 'denied', code: 'forbidden', reason: 'quota_exceeded', status: 403 }) });
    open(`#/note/${uid(1)}`);
    await act(async () => {
      pick('note-edit-img-input', jpg());
    });
    await act(async () => {
      await sendNext();
    });
    const msg = await screen.findByTestId('note-edit-img-msg');
    expect(msg.textContent).toContain('空间满了，图片没传上');
    expect(screen.getByTestId('note-edit-img-trash').getAttribute('href')).toContain('#/trash');
    // 这张图标“没传上”，有“删除”“重新插入”
    const id = collection<Row>('note_images').getSnapshot()[0]?.id ?? '';
    expect(screen.getByTestId(`note-image-${id}`).getAttribute('data-state')).toBe('failed');
    expect(screen.getByTestId(`note-image-delete-${id}`)).toBeTruthy();
    expect(screen.getByTestId(`note-image-reinsert-${id}`)).toBeTruthy();
  });

  it('写行被服务器拒（quota_exceeded，进发送失败区）：随手记页出带“最近删除”的提示，不上传', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
    });
    const { upload } = wire();
    open();
    // 电脑抽屉里插图的提示也由随手记页出：这里直接经上传器插（同抽屉）
    const { uploader } = await import('../data/image-uploader.ts');
    await act(async () => {
      await uploader().insert(uid(1), jpg());
    });
    await act(async () => {
      await sendNext('quota_exceeded');
    });
    const tip = await screen.findByTestId('notes-img-tip');
    expect(tip.textContent).toContain('空间满了');
    expect(screen.getByTestId('notes-img-trash').getAttribute('href')).toContain('#/trash');
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('卡片和编辑器里的图（PH.mason、NOTE_ED）', () => {
  it('卡片顶部放第一张（缩略图），右上角“+N”是另外还有几张', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(71), uid(1)) }, { row: serverImage(uid(72), uid(1)) }, { row: serverImage(uid(73), uid(1)) }]);
    });
    wire();
    open();
    const cover = screen.getByTestId(`notes-cover-${uid(1)}`);
    expect(cover.textContent).toBe('+2');
    await waitFor(() => expect(cover.querySelector('img')?.getAttribute('src')).toBe('blob:remote'));
  });

  it('服务器上取不到（not_found：另一台设备还在传，或页面关过没传上）：出“图片还没传上”，卡片封面也标；“删除”是软删（deleted_at），图从编辑器里消失', async () => {
    const b = await boot();
    await act(async () => {
      await b.outbox?.applyServer('notes', [{ row: serverNote(1) }]);
      await b.outbox?.applyServer('note_images', [{ row: serverImage(uid(71), uid(1)) }]);
    });
    wire({ missing: true });
    open(`#/note/${uid(1)}`);
    const box = await screen.findByTestId(`note-image-${uid(71)}`);
    await waitFor(() => expect(box.getAttribute('data-state')).toBe('failed'));
    expect(box.textContent).toContain('图片还没传上');
    await act(async () => {
      fireEvent.click(screen.getByTestId(`note-image-delete-${uid(71)}`));
    });
    await waitFor(() => expect(collection<Row>('note_images').get(uid(71))?.['deleted_at']).toBe(NOW));
    expect(screen.queryByTestId(`note-image-${uid(71)}`)).toBeNull();
  });
});
