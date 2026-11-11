// 随手记插图的 hooks（B4 S3）：一条随手记的图（集合里的行 + 上传器里待传的状态）、一张图的显示地址、插图提示
// • 显示地址：本页还在传的用本机那一份；别的经 data/image-view.ts 签名取字节（缩略图优先给卡片）
// • missing：服务器上暂时没有这张图（另一台设备还在传，或那边页面关了没传上）→ 界面出“图片还没传上”，过 30 秒再取一次（代码审建议）
// • failed：本页传的这张失败了（上传器里标 failed）→ 界面出“图片没传上”
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { imageView } from '../data/image-view.ts';
import { uploader, type ImgNotice, type InsertResult, type PendingImage } from '../data/image-uploader.ts';
import { thumbPath } from '../data/note-images.ts';
import { imagesByNote, type NoteImage, type Row } from '../data/note-list.ts';

export type { ImgNotice, InsertResult, PendingImage } from '../data/image-uploader.ts';
export type { ImgFailKey } from '../data/note-images.ts';
export type { NoteImage } from '../data/note-list.ts';

const usePending = (): readonly PendingImage[] => {
  const u = uploader();
  return useSyncExternalStore(u.subscribe, u.getSnapshot, u.getSnapshot);
};

/** 这条随手记的图（插入先后），每张带上传状态（不在传为 null） */
export function useNoteImages(noteId: string | null) {
  const rows = useCollection<Row>('note_images');
  const pending = usePending();
  const list = useMemo(() => (noteId === null ? [] : (imagesByNote(rows).get(noteId) ?? [])), [rows, noteId]);
  const items = useMemo(() => list.map((img) => ({ img, pending: pending.find((p) => p.id === img.id) ?? null })), [list, pending]);
  const insert = useCallback((file: File): Promise<InsertResult> => (noteId === null ? Promise.resolve({ ok: false, code: 'silent' }) : uploader().insert(noteId, file)), [noteId]);
  const remove = useCallback((id: string) => uploader().remove(id), []);
  const retry = useCallback((id: string) => uploader().retry(id), []);
  return { items, insert, remove, retry };
}

/** 输入行插图：编码成了才调 create 新建随手记，再插进去（create 回 null = 没建成） */
export const insertImage = (create: () => Promise<string | null>, file: File): Promise<InsertResult> => uploader().insert(create, file);

export type ImageSrc = { url: string | null; missing: boolean; failed: boolean };

let recheckMs = 30_000;
/** 取不到时多久再取一次（测试改短） */
export function setMissingRecheckMsForTest(ms: number | null): void {
  recheckMs = ms ?? 30_000;
}

/** 一张图的显示地址；thumb = 卡片用缩略图（有的话） */
export function useImageSrc(img: NoteImage | null, thumb: boolean): ImageSrc {
  const pending = usePending();
  const mine = img ? pending.find((p) => p.id === img.id) : undefined;
  const path = img === null ? null : thumb && img.hasThumb ? thumbPath(img.path) : img.path;
  const [got, setGot] = useState<{ path: string; src: ImageSrc } | null>(null);
  const known = path === null ? null : imageView().peek(path);
  const busy = Boolean(mine);
  useEffect(() => {
    if (path === null || busy || known) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (again: boolean): void => {
      void imageView()
        .get(path)
        .then((r) => {
          if (!live) return;
          setGot({ path, src: r.ok ? { url: r.url, missing: false, failed: false } : { url: null, missing: r.missing, failed: false } });
          // 取不到（另一台设备可能还在传）：过一会儿再取一次，只再取这一次
          if (!r.ok && r.missing && again) timer = setTimeout(() => load(false), recheckMs);
        });
    };
    load(true);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, busy, known]);
  if (mine) return { url: mine.url, missing: false, failed: mine.state === 'failed' };
  if (known) return { url: known, missing: false, failed: false };
  return got && got.path === path ? got.src : { url: null, missing: false, failed: false };
}

/** 插图的失败提示（插入、上传、写行被拒） */
export function useImageNotices(fn: (n: ImgNotice) => void): void {
  useEffect(() => uploader().onNotice(fn), [fn]);
}
