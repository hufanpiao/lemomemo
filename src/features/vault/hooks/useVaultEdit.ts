// 隐私记的编辑页、图片（B5 S5、S8）：明文只在会话内存里（data/session.ts），编辑页的草稿只在组件 state 里，上锁时页面整个换成解锁卡
// • 保存：点“保存”才发 vault {save}（隐私记不进本机 outbox、不自动保存：明文不能落本机，A18）
// • 插图：选的照片在本机重新编码成 webp（data/image-encode.ts）→ 经 vault-image 上传 → save 的 add_images 登记
// • 显示图片：useVaultImage 经会话拿 blob URL（只在内存、上锁时撤销，D3）
import { useEffect, useRef, useState } from 'react';
import type { VaultNote } from '../../../../shared/schema/vault.ts';
import { encodeVaultImage } from '../data/image-encode.ts';
import type { VaultCode } from '../data/vault-errors.ts';
import { useVault } from './useVault.ts';

export interface PendingImage {
  key: string;
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  preview: string;
}

export function useVaultImage(imageId: string, part: 'full' | 'thumb'): string | null {
  const { s, state } = useVault();
  const [url, setUrl] = useState<string | null>(null);
  const unlocked = state.phase === 'unlocked';
  useEffect(() => {
    let live = true;
    if (!unlocked) {
      setUrl(null);
      return undefined;
    }
    void s.image(imageId, part).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [s, imageId, part, unlocked]);
  return url;
}

export function useVaultEdit(id: string | null) {
  const { s, state } = useVault();
  const note: VaultNote | null = id ? state.notes?.find((n) => n.id === id) ?? null : null;
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [adds, setAdds] = useState<PendingImage[]>([]);
  const [removes, setRemoves] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<VaultCode | 'image' | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  // 本地预览的 blob URL（缩略图）：删掉这张、保存成功、离开编辑页、上锁时撤销
  const previews = useRef(new Set<string>());
  const revoke = (url: string): void => {
    URL.revokeObjectURL(url);
    previews.current.delete(url);
  };
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);
  // 列表晚到（直接打开 #/vault/<id>）：拿到这一条时填进去一次
  const filled = useRef(note !== null);
  useEffect(() => {
    if (note && !filled.current) {
      filled.current = true;
      setTitle(note.title);
      setBody(note.body);
    }
  }, [note]);
  useEffect(() => {
    if (state.phase !== 'unlocked') {
      setTitle('');
      setBody('');
      previews.current.forEach((u) => URL.revokeObjectURL(u));
      previews.current.clear();
      setAdds([]);
      filled.current = false;
    }
  }, [state.phase]);

  const images = (note?.images ?? []).filter((im) => im.deleted_at === null && !removes.includes(im.id));

  return {
    note,
    title,
    body,
    setTitle,
    setBody,
    images,
    adds,
    busy,
    error,
    savedId,
    async addFiles(files: readonly File[]): Promise<void> {
      setBusy(true);
      setError(null);
      const next: PendingImage[] = [];
      for (const f of files) {
        const r = await encodeVaultImage(f);
        if (!r.ok) {
          setError('image');
          continue;
        }
        const preview = URL.createObjectURL(r.thumb);
        previews.current.add(preview);
        next.push({ key: crypto.randomUUID(), full: r.full, thumb: r.thumb, width: r.width, height: r.height, preview });
      }
      setAdds((a) => [...a, ...next]);
      setBusy(false);
    },
    dropAdd(key: string): void {
      const hit = adds.find((x) => x.key === key);
      if (hit) revoke(hit.preview);
      setAdds((a) => a.filter((x) => x.key !== key));
    },
    removeImage(imageId: string): void {
      setRemoves((r) => [...r, imageId]);
    },
    async save(): Promise<boolean> {
      setBusy(true);
      setError(null);
      const r = await s.save({
        id: note?.id ?? savedId,
        title: title.trim(),
        body,
        addImages: adds.map((a) => ({ full: a.full, thumb: a.thumb, width: a.width, height: a.height })),
        removeImages: removes,
      });
      setBusy(false);
      if (!r.ok) {
        setError(r.code);
        return false;
      }
      setSavedId(r.value);
      adds.forEach((a) => revoke(a.preview));
      setAdds([]);
      setRemoves([]);
      return true;
    },
  };
}
