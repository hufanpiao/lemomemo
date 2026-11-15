// 隐私记的数据来源（hooks/vault-note-source.ts）
// • M5：插图区、图片地址只订仓库里自己那一块：打一个字（改正文）不让它们重渲染；这一条的图变了才重渲染
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageRowOf } from '../data/vault-store.ts';
import { installVaultSession } from '../hooks/useVault.ts';
import { createVaultNoteSource } from '../hooks/vault-note-source.ts';
import { make, note, NID } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));

const IMG = '22222222-2222-4222-8222-222222222222';
const TEXT = { title: '隐私记', empty: '', back: '隐私记' };

afterEach(() => {
  cleanup();
  installVaultSession(null);
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
