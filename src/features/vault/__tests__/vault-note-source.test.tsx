// 隐私记的数据来源（hooks/vault-note-source.ts）
// • M5：插图区、图片地址只订仓库里自己那一块：打一个字（改正文）不让它们重渲染；这一条的图变了才重渲染
// • 插图提示：空间满了经 onNotice 交给编辑页（同随手记）
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageRowOf, noteRowOf } from '../data/vault-store.ts';
import { installVaultSession } from '../hooks/useVault.ts';
import { createVaultNoteSource } from '../hooks/vault-note-source.ts';
import { make, note, NID, unlocked } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));

const IMG = '22222222-2222-4222-8222-222222222222';
const TEXT = { title: '隐私记', empty: '', back: '隐私记', trash: '最近删除' };

afterEach(() => {
  cleanup();
  installVaultSession(null);
});

describe('插图提示（负责人 11-25 弹窗：隐私记空间满了“要，和随手记一样弹”）', () => {
  it('带新图的 save 回 too_large：onNotice 收到 quota（编辑页出“空间满了”，最近删除跳 #/vault/trash）；退订后不再收', async () => {
    const m = await unlocked({ save: () => ({ ok: false, code: 'too_large' }) });
    const src = createVaultNoteSource(m.s, TEXT);
    const seen: unknown[] = [];
    const off = src.onNotice((n) => seen.push(n));
    const row = noteRowOf(note());
    m.s.store.put(row);
    m.s.queue.addImage(row, { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ key: 'quota', noteId: NID }]);
    off();
    m.s.queue.retry(NID);
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
  });
});

describe('M5：按 id 选择性订阅', () => {
  it('改正文：useImages、useImageSrc 都不重渲染；这张图上传状态变了才重渲染', () => {
    const { s } = make();
    installVaultSession(s);
    s.store.load([note()]);
    s.store.putImage(imageRowOf(NID, { id: IMG, has_thumb: true, width: 10, height: 6, bytes: 100, deleted_at: null }));
    const src = createVaultNoteSource(s, TEXT);
    let imgsRenders = 0;
    let srcRenders = 0;
    function Imgs() {
      const api = src.useImages(NID);
      imgsRenders += 1;
      return <i>{api.items.length}</i>;
    }
    function Src() {
      src.useImageSrc({ id: IMG, noteId: NID, path: '', hasThumb: true, width: 10, height: 6 }, true);
      srcRenders += 1;
      return null;
    }
    render(
      <>
        <Imgs />
        <Src />
      </>,
    );
    const [i0, s0] = [imgsRenders, srcRenders];
    act(() => {
      s.store.patch(NID, { body: '打一个字' });
      s.store.patch(NID, { body: '打两个字' });
    });
    expect(imgsRenders).toBe(i0);
    expect(srcRenders).toBe(s0);
    act(() => s.store.setUpload(IMG, 'failed'));
    expect(imgsRenders).toBe(i0 + 1);
    expect(srcRenders).toBe(s0 + 1);
  });
});
